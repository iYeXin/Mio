import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'errors.dart';

/// HTTP client and server exposed through the bridge.
///
/// Binary data never travels through JSON: request bodies come from strings or
/// sandbox files, responses are either text or a sandbox file the page can read
/// with `fs.blobUrl`. Requests honour the usual proxy environment variables.
class MioHttpApi {
  MioHttpApi({
    required this.emit,
    required this.resolvePath,
    required this.platformName,
    required this.scratchDir,
  });

  final void Function(String name, Object? data) emit;

  /// Resolves a page-relative path inside the app data directory.
  final String Function(String path) resolvePath;

  final String platformName;

  /// Directory used for response bodies and uploads; inside the sandbox.
  final Directory scratchDir;

  static const int defaultTimeoutMs = 30000;
  static const int maxTimeoutMs = 120000;
  static const int defaultMaxBodyBytes = 8 * 1024 * 1024;
  static const Duration responseTimeout = Duration(seconds: 60);
  static const Duration progressInterval = Duration(milliseconds: 120);

  HttpServer? _server;
  final Map<String, _PendingResponse> _pending = <String, _PendingResponse>{};
  int _nextRequestId = 1;
  int _nextTransferId = 1;

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'http.request':
        return await _request(params);
      case 'http.download':
        return await _download(params);
      case 'http.upload':
        return await _upload(params);
      case 'http.serve':
        return await _serve(params);
      case 'http.respond':
        return await _respond(params);
      case 'http.stop':
        return await _stop();
      default:
        throw MioApiException(
          'METHOD_NOT_FOUND',
          'Unknown Mio HTTP method: $method',
        );
    }
  }

  // --------------------------------------------------------------- transfers

  Future<Object?> _request(Map<String, dynamic> params) async {
    final client = _clientFor(params);
    final response = await _send(client, params);
    final headers = _headersToJson(response.headers);
    final contentType = response.headers.contentType?.mimeType ?? '';
    final saveTo = _optionalString(params, 'saveTo');

    try {
      if (saveTo != null) {
        final path = resolvePath(saveTo);
        final bytes = await _writeStream(
          response,
          path,
          expected: response.contentLength >= 0 ? response.contentLength : null,
        );
        return <String, Object?>{
          'status': response.statusCode,
          'url': _finalUrl(params, response),
          'headers': headers,
          'bytes': bytes,
          'path': saveTo,
        };
      }

      final isText = _isTextual(contentType);
      final maxBytes = _optionalInt(params, 'maxBytes') ?? defaultMaxBodyBytes;
      final builder = BytesBuilder(copy: false);
      await for (final chunk in response) {
        builder.add(chunk);
        if (builder.length > maxBytes && !isText) {
          throw MioApiException(
            'HTTP_RESPONSE_TOO_LARGE',
            'Response exceeds $maxBytes bytes; use saveTo or http.download',
            {'limit': maxBytes, 'contentType': contentType},
          );
        }
      }
      final bytes = builder.takeBytes();
      if (isText && bytes.length <= maxBytes) {
        return <String, Object?>{
          'status': response.statusCode,
          'url': _finalUrl(params, response),
          'headers': headers,
          'bytes': bytes.length,
          'contentType': contentType,
          'text': utf8.decode(bytes, allowMalformed: true),
        };
      }
      final path = await _scratchFile('response');
      await File(resolvePath(path)).writeAsBytes(bytes, flush: true);
      return <String, Object?>{
        'status': response.statusCode,
        'url': _finalUrl(params, response),
        'headers': headers,
        'bytes': bytes.length,
        'contentType': contentType,
        'path': path,
      };
    } finally {
      client.close(force: true);
    }
  }

  Future<Object?> _download(Map<String, dynamic> params) async {
    final saveTo = resolvePath(_requiredString(params, 'path'));
    final resume = params['resume'] == true;
    final transferId = _optionalString(params, 'id') ?? 'download-${_nextTransferId++}';

    final file = File(saveTo);
    var startAt = 0;
    if (resume && await file.exists()) startAt = await file.length();

    final request = Map<String, dynamic>.from(params);
    if (startAt > 0) {
      final headers = Map<String, dynamic>.from(
        (params['headers'] as Map?) ?? const <String, dynamic>{},
      );
      headers['range'] = 'bytes=$startAt-';
      request['headers'] = headers;
    }

    final client = _clientFor(params);
    try {
      final response = await _send(client, request);
      if (startAt > 0 && response.statusCode == HttpStatus.ok) {
        // The server ignored the range: start over.
        startAt = 0;
      }
      if (startAt > 0 && response.statusCode != HttpStatus.partialContent) {
        await response.drain<void>();
        throw MioApiException(
          'HTTP_RANGE_UNSUPPORTED',
          'Server did not honour the resume range (status ${response.statusCode})',
        );
      }

      final expected = response.contentLength >= 0 ? response.contentLength : null;
      final total = expected == null ? null : startAt + expected;
      final bytes = await _writeStream(
        response,
        saveTo,
        transfer: _Transfer(
          id: transferId,
          direction: 'download',
          emit: emit,
          offset: startAt,
          total: total,
        ),
        expected: expected,
        appendFrom: startAt,
      );
      return <String, Object?>{
        'status': response.statusCode,
        'path': params['path'],
        'bytes': bytes,
        'transferred': bytes - startAt,
        'headers': _headersToJson(response.headers),
        'resumed': startAt > 0,
      };
    } finally {
      client.close(force: true);
    }
  }

  Future<Object?> _upload(Map<String, dynamic> params) async {
    final source = resolvePath(_requiredString(params, 'path'));
    final file = File(source);
    if (!await file.exists()) {
      throw MioApiException('HTTP_ERROR', 'Upload source not found', {
        'path': params['path'],
      });
    }
    final length = await file.length();
    final url = Uri.parse(_requiredString(params, 'url'));
    _checkScheme(url);
    final method = (_optionalString(params, 'method') ?? 'PUT').toUpperCase();
    final transferId = _optionalString(params, 'id') ?? 'upload-${_nextTransferId++}';
    final transfer = _Transfer(
      id: transferId,
      direction: 'upload',
      emit: emit,
      offset: 0,
      total: length,
    );

    final client = _clientFor(params);
    try {
      final request = await client.openUrl(method, url);
      request.followRedirects = params['followRedirects'] != false;
      _applyHeaders(request, params['headers']);
      request.headers.contentLength = length;
      if (!request.headers.value('content-type').toString().contains('/')) {
        request.headers.contentType = ContentType.binary;
      }
      var sent = 0;
      await for (final chunk in file.openRead()) {
        request.add(chunk);
        sent += chunk.length;
        transfer.update(sent);
      }
      final response = await request.close().timeout(_timeout(params));
      final body = BytesBuilder(copy: false);
      await for (final chunk in response) {
        body.add(chunk);
        if (body.length > 1024 * 1024) break;
      }
      return <String, Object?>{
        'status': response.statusCode,
        'bytes': sent,
        'headers': _headersToJson(response.headers),
        'body': utf8.decode(body.takeBytes(), allowMalformed: true),
      };
    } on TimeoutException {
      throw MioApiException('HTTP_TIMEOUT', 'Upload timed out');
    } finally {
      client.close(force: true);
    }
  }

  Future<int> _writeStream(
    HttpClientResponse response,
    String path, {
    _Transfer? transfer,
    int? expected,
    int appendFrom = 0,
  }) async {
    final target = File(path);
    await target.parent.create(recursive: true);
    final part = File('${target.path}.part');

    if (appendFrom > 0) {
      // The existing file holds the prefix we asked the server to skip.
      if (await target.exists()) {
        if (await part.exists()) await part.delete();
        await target.rename(part.path);
      }
    } else if (await part.exists()) {
      await part.delete();
    }

    final sink = part.openWrite(
      mode: appendFrom > 0 ? FileMode.append : FileMode.write,
    );
    var received = appendFrom;
    try {
      await for (final chunk in response) {
        sink.add(chunk);
        received += chunk.length;
        transfer?.update(received);
      }
      await sink.flush();
    } finally {
      await sink.close();
    }

    if (expected != null && received - appendFrom != expected) {
      await part.delete().catchError((_) => part);
      throw MioApiException('HTTP_INCOMPLETE', 'Transfer stopped early', {
        'expected': expected,
        'received': received - appendFrom,
      });
    }
    if (await target.exists()) await target.delete();
    await part.rename(target.path);
    return received;
  }

  // ---------------------------------------------------------------- requests

  Future<HttpClientResponse> _send(
    HttpClient client,
    Map<String, dynamic> params,
  ) async {
    final url = Uri.parse(_requiredString(params, 'url'));
    _checkScheme(url);
    final method = (_optionalString(params, 'method') ?? 'GET').toUpperCase();
    final timeout = _timeout(params);
    client.connectionTimeout = timeout;

    try {
      final request = await client.openUrl(method, url).timeout(timeout);
      request.followRedirects = params['followRedirects'] != false;
      _applyHeaders(request, params['headers']);

      final body = params['body'];
      if (body is String && body.isNotEmpty) {
        final bytes = utf8.encode(body);
        request.headers.contentLength = bytes.length;
        request.add(bytes);
      }
      final bodyFile = _optionalString(params, 'bodyFile');
      if (bodyFile != null) {
        final bytes = await File(resolvePath(bodyFile)).readAsBytes();
        request.headers.contentLength = bytes.length;
        request.add(bytes);
      }
      return await request.close().timeout(timeout);
    } on TimeoutException {
      throw MioApiException(
        'HTTP_TIMEOUT',
        'Request timed out after ${timeout.inMilliseconds} ms',
      );
    } on SocketException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message, {
        'osError': error.osError?.message,
      });
    } on HandshakeException catch (error) {
      throw MioApiException('HTTP_TLS_ERROR', error.message);
    } on HttpException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message);
    } on FormatException catch (error) {
      throw MioApiException('HTTP_BAD_URL', error.message);
    }
  }

  void _applyHeaders(HttpClientRequest request, Object? value) {
    if (value is! Map) return;
    value.forEach((key, headerValue) {
      if (headerValue == null || key == null) return;
      request.headers.set('$key', '$headerValue');
    });
  }

  HttpClient _clientFor(Map<String, dynamic> params) {
    final client = HttpClient()..autoUncompress = true;
    final proxy = _resolveProxy(params);
    if (proxy != null) {
      client.findProxy = (uri) => _proxyFor(uri, proxy);
    }
    final caFile = _optionalString(params, 'caFile');
    if (caFile != null) {
      final context = SecurityContext(withTrustedRoots: true)
        ..setTrustedCertificates(resolvePath(caFile));
      return HttpClient(context: context)..autoUncompress = true;
    }
    return client;
  }

  String? _resolveProxy(Map<String, dynamic> params) {
    final explicit = _optionalString(params, 'proxy');
    if (explicit != null) return explicit;
    final env = Platform.environment;
    final candidates = [
      env['HTTPS_PROXY'],
      env['https_proxy'],
      env['HTTP_PROXY'],
      env['http_proxy'],
      env['ALL_PROXY'],
    ];
    for (final candidate in candidates) {
      if (candidate != null && candidate.trim().isNotEmpty) return candidate.trim();
    }
    return null;
  }

  String _proxyFor(Uri uri, String proxy) {
    final noProxy = Platform.environment['NO_PROXY'] ??
        Platform.environment['no_proxy'] ??
        '';
    final host = uri.host.toLowerCase();
    final bypass = noProxy
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .where((entry) => entry.isNotEmpty)
        .any((entry) => entry == '*' || host == entry || host.endsWith('.$entry'));
    if (bypass) return 'DIRECT';
    final normalized = proxy.contains('://') ? proxy : 'http://$proxy';
    final parsed = Uri.tryParse(normalized);
    if (parsed == null || parsed.host.isEmpty) return 'DIRECT';
    final scheme = parsed.scheme == 'https' ? 'HTTPS' : 'PROXY';
    return '$scheme ${parsed.host}:${parsed.port == 0 ? 8080 : parsed.port}';
  }

  Duration _timeout(Map<String, dynamic> params) {
    final ms = _optionalInt(params, 'timeoutMs') ?? defaultTimeoutMs;
    return Duration(milliseconds: ms.clamp(1000, maxTimeoutMs));
  }

  void _checkScheme(Uri url) {
    if (url.scheme != 'http' && url.scheme != 'https') {
      throw MioApiException(
        'HTTP_BAD_URL',
        'Only http and https URLs are allowed',
      );
    }
  }

  bool _isTextual(String contentType) {
    if (contentType.isEmpty) return false;
    return contentType.startsWith('text/') ||
        contentType.contains('json') ||
        contentType.contains('xml') ||
        contentType.contains('javascript') ||
        contentType.contains('x-www-form-urlencoded') ||
        contentType.contains('svg');
  }

  String _finalUrl(Map<String, dynamic> params, HttpClientResponse response) {
    if (response.redirects.isEmpty) return params['url'] as String;
    return response.redirects.last.location.toString();
  }

  Future<String> _scratchFile(String prefix) async {
    await scratchDir.create(recursive: true);
    // Keep the scratch directory from growing without bound.
    await for (final entity in scratchDir.list()) {
      if (entity is File) {
        final stat = await entity.stat();
        if (DateTime.now().difference(stat.modified) > const Duration(hours: 6)) {
          await entity.delete().catchError((_) => entity);
        }
      }
    }
    final name = '$prefix-${DateTime.now().microsecondsSinceEpoch}.bin';
    final relative = _relativeToSandbox(File('${scratchDir.path}/$name'));
    return relative;
  }

  String _relativeToSandbox(File file) {
    final sandbox = resolvePath('.');
    final relative = file.path.startsWith(sandbox)
        ? file.path.substring(sandbox.length)
        : file.path;
    return relative.replaceAll('\\', '/').replaceAll(RegExp(r'^/+'), '');
  }

  // ------------------------------------------------------------------ server

  Future<Object?> _serve(Map<String, dynamic> params) async {
    if (_server != null) {
      return <String, Object?>{
        'host': _server!.address.address,
        'port': _server!.port,
        'alreadyRunning': true,
      };
    }

    final host = _optionalString(params, 'host') ?? '127.0.0.1';
    final port = _optionalInt(params, 'port') ?? 0;
    final maxBodyBytes = _optionalInt(params, 'maxBodyBytes') ?? 16 * 1024 * 1024;

    try {
      final server = await HttpServer.bind(host, port, shared: false);
      server.autoCompress = true;
      _server = server;
      unawaited(_acceptLoop(server, maxBodyBytes));
      return <String, Object?>{
        'host': server.address.address,
        'port': server.port,
      };
    } on SocketException catch (error) {
      throw MioApiException('HTTP_BIND_FAILED', error.message, {
        'host': host,
        'port': port,
      });
    }
  }

  Future<void> _acceptLoop(HttpServer server, int maxBodyBytes) async {
    await for (final request in server) {
      unawaited(_handleRequest(request, maxBodyBytes));
    }
  }

  Future<void> _handleRequest(HttpRequest request, int maxBodyBytes) async {
    final id = '${_nextRequestId++}';
    final pending = _PendingResponse();
    _pending[id] = pending;

    try {
      final body = BytesBuilder(copy: false);
      await for (final chunk in request) {
        body.add(chunk);
        if (body.length > maxBodyBytes) {
          request.response.statusCode = HttpStatus.requestEntityTooLarge;
          request.response.write('body exceeds $maxBodyBytes bytes');
          await request.response.close();
          _pending.remove(id);
          return;
        }
      }

      emit('http.request', <String, Object?>{
        'id': id,
        'method': request.method,
        'path': request.uri.path,
        'query': request.uri.query,
        'headers': _requestHeaders(request),
        'remote': request.connectionInfo?.remoteAddress.address ?? '',
        'bodyBase64': base64Encode(body.takeBytes()),
      });

      final response = await pending.completer.future.timeout(
        responseTimeout,
        onTimeout: () => _ServerResponse(
          status: HttpStatus.gatewayTimeout,
          headers: const <String, String>{},
          body: Uint8List(0),
        ),
      );

      request.response.statusCode = response.status;
      response.headers.forEach((name, value) {
        request.response.headers.set(name, value);
      });
      request.response.add(response.body);
      await request.response.close();
    } catch (_) {
      try {
        request.response.statusCode = HttpStatus.internalServerError;
        await request.response.close();
      } catch (_) {
        // The client already disconnected.
      }
    } finally {
      _pending.remove(id);
    }
  }

  Future<Object?> _respond(Map<String, dynamic> params) async {
    final id = _requiredString(params, 'id');
    final pending = _pending[id];
    if (pending == null || pending.completer.isCompleted) {
      throw MioApiException('HTTP_NO_PENDING_REQUEST', 'No pending request', {
        'id': id,
      });
    }
    pending.completer.complete(
      _ServerResponse(
        status: _optionalInt(params, 'status') ?? 200,
        headers: _stringHeaders(params['headers']),
        body: _bodyBytes(params),
      ),
    );
    return null;
  }

  Uint8List _bodyBytes(Map<String, dynamic> params) {
    final text = params['body'];
    if (text is String) return Uint8List.fromList(utf8.encode(text));
    final path = _optionalString(params, 'bodyFile');
    if (path != null) return File(resolvePath(path)).readAsBytesSync();
    return Uint8List(0);
  }

  Future<Object?> _stop() async {
    final server = _server;
    _server = null;
    for (final pending in _pending.values) {
      if (!pending.completer.isCompleted) {
        pending.completer.complete(_ServerResponse(
          status: HttpStatus.serviceUnavailable,
          headers: const <String, String>{},
          body: Uint8List(0),
        ));
      }
    }
    _pending.clear();
    await server?.close(force: true);
    return <String, Object?>{'stopped': server != null};
  }

  Future<void> dispose() async {
    await _stop();
  }

  // ------------------------------------------------------------------ helpers

  Map<String, Object?> _requestHeaders(HttpRequest request) {
    final result = <String, Object?>{};
    request.headers.forEach((name, values) {
      result[name.toLowerCase()] = values.length == 1 ? values.first : values;
    });
    return result;
  }

  Map<String, Object?> _headersToJson(HttpHeaders headers) {
    final result = <String, Object?>{};
    headers.forEach((name, values) {
      result[name.toLowerCase()] = values.length == 1 ? values.first : values;
    });
    return result;
  }

  Map<String, String> _stringHeaders(Object? value) {
    if (value is! Map) return const <String, String>{};
    return <String, String>{
      for (final entry in value.entries)
        if (entry.key != null && entry.value != null)
          '${entry.key}': '${entry.value}',
    };
  }

  String _requiredString(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is String && value.isNotEmpty) return value;
    throw MioApiException('BAD_REQUEST', 'Missing parameter: $key');
  }

  String? _optionalString(Map<String, dynamic> params, String key) {
    final value = params[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  int? _optionalInt(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    return null;
  }
}

class _PendingResponse {
  final Completer<_ServerResponse> completer = Completer<_ServerResponse>();
}

class _ServerResponse {
  _ServerResponse({
    required this.status,
    required this.headers,
    required this.body,
  });

  final int status;
  final Map<String, String> headers;
  final Uint8List body;
}

/// Emits throttled progress events for a download or upload.
class _Transfer {
  _Transfer({
    required this.id,
    required this.direction,
    required this.emit,
    required this.offset,
    required this.total,
  });

  final String id;
  final String direction;
  final void Function(String name, Object? data) emit;
  final int offset;
  final int? total;

  DateTime _last = DateTime.fromMillisecondsSinceEpoch(0);

  void update(int received) {
    final now = DateTime.now();
    if (now.difference(_last) < MioHttpApi.progressInterval) return;
    _last = now;
    emit('http.progress', <String, Object?>{
      'id': id,
      'direction': direction,
      'received': received,
      'total': total,
      'ratio': total == null || total == 0 ? null : received / total!,
    });
  }
}
