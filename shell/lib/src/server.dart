import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'api.dart';
import 'app_manifest.dart';
import 'asar.dart';
import 'atomic_file.dart';
import 'http_range.dart';

class MioServer {
  MioServer({
    required this.manifest,
    required this.api,
    this.asar,
    this.devUrl,
  });

  final AppManifest manifest;
  final MioApi api;
  final AsarArchive? asar;
  final String? devUrl;

  HttpServer? _server;
  String? _token;
  String? _devOrigin;
  final Set<WebSocket> _sockets = <WebSocket>{};
  StreamSubscription<HttpRequest>? _subscription;

  int get port => _server?.port ?? 0;
  String get token => _token ?? '';
  bool get isRunning => _server != null;

  String get url => 'http://127.0.0.1:$port/';

  Future<void> start() async {
    if (_server != null) return;
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _token = _randomToken();
    if (devUrl != null) {
      _devOrigin = Uri.parse(devUrl!).origin;
    }
    api.bindEventSink(_broadcast);
    _subscription = _server!.listen(
      _handleRequest,
      onError: (Object error, StackTrace stack) {
        stderr.writeln('Mio server error: $error\n$stack');
      },
      cancelOnError: false,
    );
  }

  String devUrlWithBoot() {
    final raw = devUrl;
    if (raw == null) return url;
    final uri = Uri.parse(raw);
    final query = Map<String, String>.from(uri.queryParameters);
    query['__mio_port'] = port.toString();
    query['__mio_token'] = token;
    query['__mio_platform'] = api.platformName;
    return uri.replace(queryParameters: query).toString();
  }

  Future<void> stop() async {
    for (final socket in _sockets.toList()) {
      await socket.close();
    }
    _sockets.clear();
    await _subscription?.cancel();
    _subscription = null;
    await _server?.close(force: true);
    _server = null;
    api.bindEventSink(null);
  }

  Future<void> _handleRequest(HttpRequest request) async {
    try {
      final path = request.uri.path;
      if (path == '/__mio__/rpc') {
        await _handleWebSocket(request);
        return;
      }
      if (path == '/__mio__/health') {
        await _jsonResponse(request, {
          'ok': true,
          'app': manifest.id,
          'version': manifest.version,
          'apiVersion': mioApiVersion,
        });
        return;
      }
      if (path == '/__mio__/bootstrap.js') {
        await _serveAsarPath(request, '__mio__/bootstrap.js', forceNoStore: true);
        return;
      }
      if (path == '/__mio__/blob') {
        await _handleBlob(request);
        return;
      }

      final archive = asar;
      if (archive == null) {
        await _notFound(request);
        return;
      }

      var requested = Uri.decodeComponent(path);
      while (requested.startsWith('/')) {
        requested = requested.substring(1);
      }
      if (requested.isEmpty) requested = manifest.entry;
      if (requested.endsWith('/')) requested += 'index.html';

      var node = archive.entry(requested);
      if (node != null && node.isDirectory) {
        requested = requested.endsWith('/')
            ? '${requested}index.html'
            : '$requested/index.html';
        node = archive.entry(requested);
      }

      if (node == null && _acceptsHtml(request)) {
        requested = manifest.entry;
        node = archive.entry(requested);
      }

      if (node == null || node.isDirectory) {
        await _notFound(request);
        return;
      }

      await _serveAsarPath(request, requested);
    } catch (error, stack) {
      stderr.writeln('Mio request failed: $error\n$stack');
      try {
        request.response.statusCode = 500;
        request.response.headers.contentType = ContentType.text;
        request.response.write('Internal Server Error');
        await request.response.close();
      } catch (_) {
        // The response may already be committed; nothing else to do.
      }
    }
  }

  Future<void> _serveAsarPath(
    HttpRequest request,
    String path, {
    bool forceNoStore = false,
  }) async {
    final archive = asar;
    if (archive == null) {
      await _notFound(request);
      return;
    }
    final node = archive.entry(path);
    if (node == null || node.isDirectory) {
      await _notFound(request);
      return;
    }

    var bytes = await archive.read(path);
    final contentType = _contentType(path);
    final isHtml = contentType.mimeType == 'text/html';
    if (isHtml) {
      bytes = Uint8List.fromList(
        utf8.encode(_injectBootstrap(utf8.decode(bytes, allowMalformed: true))),
      );
    }

    request.response.headers.set('X-Content-Type-Options', 'nosniff');
    request.response.headers.set('Referrer-Policy', 'no-referrer');
    request.response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    request.response.headers.contentType = contentType;
    request.response.headers.set(
      'Cache-Control',
      forceNoStore || isHtml ? 'no-store' : 'public, max-age=0',
    );
    request.response.contentLength = bytes.length;

    if (request.method == 'HEAD') {
      await request.response.close();
      return;
    }
    request.response.add(bytes);
    await request.response.close();
  }

  // Blob transport.
  //
  // File bytes never travel through the JSON-RPC control channel: base64 over
  // JSON doubles memory and blocks the parser on multi-megabyte payloads.
  // They go through HTTP instead, which streams, supports Range, and lets the
  // page use plain fetch().
  //
  //   GET|HEAD /__mio__/blob?token=..&path=..   read a file (Range supported)
  //   POST|PUT /__mio__/blob?token=..&path=..   write a file from the body
  //
  // The token is the same per-launch secret the WebSocket uses, and paths go
  // through the same validator as the fs.* JSON methods.

  Future<void> _handleBlob(HttpRequest request) async {
    final origin = request.headers.value('origin');
    if (request.method == 'OPTIONS') {
      request.response.statusCode = HttpStatus.noContent;
      _applyCors(request, origin);
      await request.response.close();
      return;
    }
    if (origin != null && !_originAllowed(origin)) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    final token = request.uri.queryParameters['token'];
    if (token == null || !_constantTimeEquals(token, _token ?? '')) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    final requested = request.uri.queryParameters['path'];
    if (requested == null || requested.isEmpty) {
      request.response.statusCode = HttpStatus.badRequest;
      request.response.write('Missing path');
      await request.response.close();
      return;
    }

    final String resolved;
    try {
      resolved = api.resolveDataPath(requested);
    } on MioApiException catch (error) {
      request.response.statusCode = HttpStatus.forbidden;
      request.response.write(error.message);
      await request.response.close();
      return;
    }

    if (request.method == 'GET' || request.method == 'HEAD') {
      await _serveBlob(request, resolved, origin);
      return;
    }
    if (request.method == 'POST' || request.method == 'PUT') {
      await _receiveBlob(request, resolved, origin);
      return;
    }

    request.response.statusCode = HttpStatus.methodNotAllowed;
    _applyCors(request, origin);
    await request.response.close();
  }

  Future<void> _serveBlob(HttpRequest request, String filePath, String? origin) async {
    final file = File(filePath);
    if (!await file.exists()) {
      request.response.statusCode = HttpStatus.notFound;
      _applyCors(request, origin);
      await request.response.close();
      return;
    }

    final length = await file.length();
    final response = request.response;
    _applyCors(request, origin);
    response.headers.set('Accept-Ranges', 'bytes');
    response.headers.set('Cache-Control', 'no-store');
    response.headers.contentType = ContentType.binary;

    final range = parseByteRange(request.headers.value('range'), length);
    if (range == null) {
      response.statusCode = HttpStatus.ok;
      response.contentLength = length;
      if (request.method == 'HEAD' || length == 0) {
        await response.close();
        return;
      }
      await response.addStream(file.openRead());
      await response.close();
      return;
    }

    final start = range.start;
    final end = range.end;
    response.statusCode = HttpStatus.partialContent;
    response.headers.set('Content-Range', 'bytes $start-$end/$length');
    response.contentLength = end - start + 1;
    if (request.method == 'HEAD') {
      await response.close();
      return;
    }
    await response.addStream(file.openRead(start, end + 1));
    await response.close();
  }

  Future<void> _receiveBlob(HttpRequest request, String filePath, String? origin) async {
    final file = File(filePath);
    // Uploads land in a sibling `.part` file and are renamed into place only
    // after the body is fully written: a dropped connection must not leave a
    // truncated file that later looks like a valid one.
    try {
      await atomicWriteStream(file, request);
    } catch (error) {
      request.response.statusCode = HttpStatus.internalServerError;
      _applyCors(request, origin);
      request.response.write('Write failed: $error');
      await request.response.close();
      return;
    }

    request.response.statusCode = HttpStatus.noContent;
    _applyCors(request, origin);
    await request.response.close();
  }

  void _applyCors(HttpRequest request, String? origin) {
    if (origin == null || !_originAllowed(origin)) return;
    final headers = request.response.headers;
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges',
    );
  }

  Future<void> _handleWebSocket(HttpRequest request) async {
    final token = request.uri.queryParameters['token'];
    if (token == null || !_constantTimeEquals(token, _token ?? '')) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    final origin = request.headers.value('origin');
    if (origin == null || !_originAllowed(origin)) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }

    final socket = await WebSocketTransformer.upgrade(request);
    _sockets.add(socket);
    socket.done.whenComplete(() => _sockets.remove(socket));

    () async {
      try {
        await for (final data in socket) {
          if (data is! String) {
            await _sendError(socket, null, -32600, 'Only JSON text messages are supported');
            continue;
          }
          // Handled concurrently: a slow API call (native code, a large file, a
          // dialog waiting on the user) must not stall every other request on
          // the bridge. Responses carry their JSON-RPC id, so order is free.
          unawaited(_handleSocketMessage(socket, data));
        }
      } catch (error, stack) {
        stderr.writeln('Mio WebSocket error: $error\n$stack');
      } finally {
        _sockets.remove(socket);
      }
    }();
  }

  Future<void> _handleSocketMessage(WebSocket socket, String raw) async {
    Object? id;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        await _sendError(socket, null, -32600, 'Invalid request');
        return;
      }
      id = decoded['id'];
      final method = decoded['method'];
      if (method is! String) {
        await _sendError(socket, id, -32600, 'Missing method');
        return;
      }
      final rawParams = decoded['params'];
      final params = rawParams is Map<String, dynamic>
          ? rawParams
          : <String, dynamic>{};

      try {
        final result = await api.call(method, params);
        if (id != null) {
          await _send(socket, {
            'jsonrpc': '2.0',
            'id': id,
            'result': result,
          });
        }
      } on MioApiException catch (error) {
        await _sendError(
          socket,
          id,
          _jsonRpcCode(error.code),
          error.message,
          error.data,
          error.code,
        );
      } catch (error) {
        await _sendError(socket, id, -32603, error.toString());
      }
    } catch (error) {
      await _sendError(socket, id, -32700, 'Parse error: $error');
    }
  }

  void _broadcast(String name, Object? data) {
    final payload = jsonEncode({
      'jsonrpc': '2.0',
      'method': 'event',
      'params': {'name': name, 'data': data},
    });
    for (final socket in _sockets.toList()) {
      if (socket.readyState == WebSocket.open) {
        socket.add(payload);
      }
    }
  }

  Future<void> _send(WebSocket socket, Map<String, Object?> payload) async {
    if (socket.readyState == WebSocket.open) {
      socket.add(jsonEncode(payload));
    }
  }

  /// Sends a JSON-RPC error.
  ///
  /// [code] is the numeric JSON-RPC code required by the spec. [mioCode] is the
  /// stable symbolic code (`FS_FORBIDDEN`, `PROCESS_NOT_FOUND`, ...) that app
  /// code should branch on; it rides along as a sibling member because the spec
  /// fixes `code` to an integer.
  Future<void> _sendError(
    WebSocket socket,
    Object? id,
    int code,
    String message, [
    Object? data,
    String? mioCode,
  ]) async {
    await _send(socket, {
      'jsonrpc': '2.0',
      'id': id,
      'error': {
        'code': code,
        'message': message,
        'data': ?data,
        'mioCode': ?mioCode,
      },
    });
  }

  int _jsonRpcCode(String code) {
    switch (code) {
      case 'METHOD_NOT_FOUND':
        return -32601;
      case 'BAD_REQUEST':
      case 'FS_FORBIDDEN':
      case 'PROCESS_FORBIDDEN':
        return -32602;
      case 'UNSUPPORTED':
        return -32000;
      case 'FS_NOT_FOUND':
      case 'PROCESS_NOT_FOUND':
        return -32004;
      default:
        return -32000;
    }
  }

  String _injectBootstrap(String html) {
    if (html.contains('__MIO_BOOT__')) return html;
    final boot = jsonEncode({
      'port': port,
      'token': token,
      'apiVersion': mioApiVersion,
      'platform': api.platformName,
      'app': {
        'id': manifest.id,
        'name': manifest.name,
        'version': manifest.version,
      },
    }).replaceAll('</', r'<\/');
    final scripts = '<script>window.__MIO_BOOT__=$boot</script>'
        '<script src="/__mio__/bootstrap.js"></script>';
    final headIndex = html.toLowerCase().indexOf('<head');
    if (headIndex < 0) return '<head>$scripts</head>$html';
    final headEnd = html.indexOf('>', headIndex);
    if (headEnd < 0) return '$scripts$html';
    return html.substring(0, headEnd + 1) + scripts + html.substring(headEnd + 1);
  }

  bool _originAllowed(String origin) {
    final own = {'http://127.0.0.1:$port', 'http://localhost:$port'};
    if (own.contains(origin)) return true;
    final dev = _devOrigin;
    if (dev != null && origin == dev) return true;
    // Vite may switch between localhost and 127.0.0.1; allow the dev port.
    if (dev != null) {
      final devUri = Uri.tryParse(dev);
      final originUri = Uri.tryParse(origin);
      if (devUri != null &&
          originUri != null &&
          devUri.scheme == originUri.scheme &&
          devUri.port == originUri.port &&
          (originUri.host == '127.0.0.1' || originUri.host == 'localhost')) {
        return true;
      }
    }
    return false;
  }

  bool _acceptsHtml(HttpRequest request) {
    return (request.headers.value('accept') ?? '').contains('text/html');
  }

  Future<void> _notFound(HttpRequest request) async {
    request.response.statusCode = HttpStatus.notFound;
    request.response.headers.contentType = ContentType.text;
    request.response.write('Not found');
    await request.response.close();
  }

  Future<void> _jsonResponse(HttpRequest request, Object value) async {
    request.response.headers.contentType = ContentType.json;
    request.response.headers.set('Cache-Control', 'no-store');
    request.response.write(jsonEncode(value));
    await request.response.close();
  }

  static String _randomToken() {
    final random = Random.secure();
    final bytes = List<int>.generate(32, (_) => random.nextInt(256));
    return base64UrlEncode(bytes).replaceAll('=', '');
  }

  static bool _constantTimeEquals(String a, String b) {
    if (a.length != b.length) return false;
    var result = 0;
    for (var index = 0; index < a.length; index++) {
      result |= a.codeUnitAt(index) ^ b.codeUnitAt(index);
    }
    return result == 0;
  }

  static ContentType _contentType(String path) {
    final lower = path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return ContentType.html;
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
      return ContentType('text', 'javascript', charset: 'utf-8');
    }
    if (lower.endsWith('.css')) return ContentType('text', 'css', charset: 'utf-8');
    if (lower.endsWith('.json') || lower.endsWith('.map')) return ContentType.json;
    if (lower.endsWith('.svg')) return ContentType('image', 'svg+xml');
    if (lower.endsWith('.png')) return ContentType('image', 'png');
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return ContentType('image', 'jpeg');
    if (lower.endsWith('.gif')) return ContentType('image', 'gif');
    if (lower.endsWith('.webp')) return ContentType('image', 'webp');
    if (lower.endsWith('.ico')) return ContentType('image', 'x-icon');
    if (lower.endsWith('.woff')) return ContentType('font', 'woff');
    if (lower.endsWith('.woff2')) return ContentType('font', 'woff2');
    if (lower.endsWith('.ttf')) return ContentType('font', 'ttf');
    if (lower.endsWith('.otf')) return ContentType('font', 'otf');
    if (lower.endsWith('.wasm')) return ContentType('application', 'wasm');
    if (lower.endsWith('.txt')) return ContentType.text;
    return ContentType.binary;
  }
}
