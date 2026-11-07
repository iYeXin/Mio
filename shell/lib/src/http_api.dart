import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'errors.dart';

/// HTTP client and server exposed through the bridge.
///
/// The page's `fetch()` is subject to CORS and to what the WebView allows, so
/// requests that need cookies, custom methods or no CORS at all go through
/// Dart's [HttpClient]. The server half lets the app accept connections from
/// other devices on the LAN, which a WebView alone cannot do.
class MioHttpApi {
  MioHttpApi({
    required this.emit,
    required this.resolvePath,
    required this.platformName,
  });

  /// Event sink used for incoming server requests.
  final void Function(String name, Object? data) emit;

  /// Resolves a page-relative path inside the app data directory.
  final String Function(String path) resolvePath;

  final String platformName;

  static const int defaultTimeoutMs = 30000;
  static const int maxTimeoutMs = 120000;
  static const int maxResponseBytes = 32 * 1024 * 1024;
  static const int defaultMaxBodyBytes = 16 * 1024 * 1024;
  static const Duration responseTimeout = Duration(seconds: 60);

  final HttpClient _client = HttpClient();
  HttpServer? _server;
  final Map<String, _PendingResponse> _pending = <String, _PendingResponse>{};
  int _nextRequestId = 1;

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'http.request':
        return await _request(params);
      case 'http.download':
        return await _download(params);
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

  // ---------------------------------------------------------------- requests

  Future<Object?> _request(Map<String, dynamic> params) async {
    final response = await _send(params);
    try {
      final bytes = await _readBody(response, maxResponseBytes);
      return <String, Object?>{
        'status': response.statusCode,
        'headers': _headersToJson(response.headers),
        'url': response.redirects.isEmpty
            ? params['url']
            : response.redirects.last.location.toString(),
        'bodyBase64': base64Encode(bytes),
        'bytes': bytes.length,
      };
    } catch (_) {
      rethrow;
    }
  }

  Future<Object?> _download(Map<String, dynamic> params) async {
    final path = resolvePath(_requiredString(params, 'path'));
    final response = await _send(params);
    final file = File(path);
    try {
      await file.parent.create(recursive: true);
      final temporary = File('${file.path}.part');
      final sink = temporary.openWrite();
      var bytes = 0;
      try {
        await response.forEach((chunk) {
          bytes += chunk.length;
          sink.add(chunk);
        });
        await sink.flush();
      } finally {
        await sink.close();
      }
      if (await file.exists()) await file.delete();
      await temporary.rename(file.path);
      return <String, Object?>{
        'status': response.statusCode,
        'path': params['path'],
        'headers': _headersToJson(response.headers),
        'bytes': bytes,
      };
    } on FileSystemException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message, {'path': error.path});
    } finally {
      // The stream is already consumed by the forEach above; nothing to drain.
    }
  }

  Future<HttpClientResponse> _send(Map<String, dynamic> params) async {
    final url = Uri.parse(_requiredString(params, 'url'));
    if (url.scheme != 'http' && url.scheme != 'https') {
      throw MioApiException(
        'HTTP_BAD_URL',
        'Only http and https URLs are allowed',
      );
    }

    final method = (_optionalString(params, 'method') ?? 'GET').toUpperCase();
    final timeoutMs = _optionalInt(params, 'timeoutMs') ?? defaultTimeoutMs;
    final followRedirects = params['followRedirects'] != false;
    _client.connectionTimeout = Duration(
      milliseconds: timeoutMs.clamp(1000, maxTimeoutMs),
    );

    try {
      final request = await _client.openUrl(method, url).timeout(
            Duration(milliseconds: timeoutMs.clamp(1000, maxTimeoutMs)),
          );
      request.followRedirects = followRedirects;
      final headers = params['headers'];
      if (headers is Map) {
        headers.forEach((key, value) {
          if (value != null) request.headers.set('$key', '$value');
        });
      }
      final body = params['bodyBase64'];
      if (body is String && body.isNotEmpty) {
        final bytes = base64Decode(body);
        request.contentLength = bytes.length;
        request.add(bytes);
      }
      return await request.close().timeout(
            Duration(milliseconds: timeoutMs.clamp(1000, maxTimeoutMs)),
          );
    } on TimeoutException {
      throw MioApiException(
        'HTTP_TIMEOUT',
        'Request timed out after $timeoutMs ms',
      );
    } on SocketException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message, {
        'osError': error.osError?.message,
      });
    } on HttpException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message);
    } on FormatException catch (error) {
      throw MioApiException('HTTP_ERROR', error.message);
    }
  }

  Future<Uint8List> _readBody(HttpClientResponse response, int limit) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
      if (builder.length > limit) {
        throw MioApiException(
          'HTTP_RESPONSE_TOO_LARGE',
          'Response exceeds $limit bytes; use http.download instead',
          {'limit': limit},
        );
      }
    }
    return builder.takeBytes();
  }

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
    final maxBodyBytes = _optionalInt(params, 'maxBodyBytes') ?? defaultMaxBodyBytes;

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
        onTimeout: () {
          request.response.statusCode = HttpStatus.gatewayTimeout;
          return _ServerResponse(
            status: HttpStatus.gatewayTimeout,
            headers: const <String, String>{},
            body: Uint8List(0),
          );
        },
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
    final body = params['bodyBase64'];
    pending.completer.complete(
      _ServerResponse(
        status: _optionalInt(params, 'status') ?? 200,
        headers: _stringHeaders(params['headers']),
        body: body is String && body.isNotEmpty
            ? base64Decode(body)
            : Uint8List(0),
      ),
    );
    return null;
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
    _client.close(force: true);
  }

  // ------------------------------------------------------------------ helpers

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
  const _ServerResponse({
    required this.status,
    required this.headers,
    required this.body,
  });

  final int status;
  final Map<String, String> headers;
  final Uint8List body;
}
