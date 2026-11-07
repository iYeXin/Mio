import 'dart:async';
import 'dart:ffi';
import 'dart:isolate';

import 'native_signatures.dart';

/// A persistent worker isolate that owns one native library.
///
/// Why a separate isolate:
///
/// - a slow or blocking export would otherwise freeze the Dart UI thread, which
///   is the same thread that serves the WebSocket bridge;
/// - calls and `mio_event` invocations are serialized on this isolate, so a
///   library that is not internally thread-safe is not called concurrently by
///   the page;
/// - a library that crashes still takes the process down — an isolate is not a
///   fault boundary — but that is documented rather than hidden.
///
/// Only scalars cross the isolate boundary, so no object graphs are copied.
class NativeWorker {
  NativeWorker._(this._isolate, this._inbox, this._errors);

  final Isolate _isolate;
  final ReceivePort _inbox;
  final ReceivePort _errors;
  final Completer<SendPort> _ready = Completer<SendPort>();
  final Map<int, Completer<Object?>> _pending = <int, Completer<Object?>>{};
  SendPort? _port;
  var _nextId = 1;
  var _closed = false;

  /// Symbols reported when the library was opened: `entry`, `event`, `stop`.
  Map<String, Object?> openResult = const <String, Object?>{};

  static Future<NativeWorker> start(String path) async {
    final inbox = ReceivePort();
    final errors = ReceivePort();
    final isolate = await Isolate.spawn(
      _workerMain,
      <Object?>[inbox.sendPort],
      debugName: 'mio-native-worker',
      onExit: errors.sendPort,
      onError: errors.sendPort,
      errorsAreFatal: false,
    );
    final worker = NativeWorker._(isolate, inbox, errors);
    worker._listen();
    try {
      await worker._ready.future.timeout(const Duration(seconds: 10));
    } on TimeoutException {
      worker.close();
      throw StateError('native worker did not handshake for $path');
    }
    final info = await worker.open(path);
    if (info == null) {
      worker.close();
      throw StateError('native worker did not open $path');
    }
    worker.openResult = info;
    return worker;
  }

  void _listen() {
    _inbox.listen((Object? message) {
      // The first message is the worker's SendPort (single-subscription port, so
      // the handshake cannot use `first`).
      if (message is SendPort) {
        _port = message;
        if (!_ready.isCompleted) _ready.complete(message);
        return;
      }
      if (message is! List || message.length < 3) return;
      final id = message[0];
      if (id is! int) return;
      final completer = _pending.remove(id);
      if (completer == null) return;
      if (message[1] == 'ok') {
        completer.complete(message[2]);
      } else {
        final detail = message.length > 3 ? '${message[3]}' : '';
        completer.completeError(_WorkerException('${message[2]}', detail));
      }
    });
    // If the isolate dies the pending calls would wait forever.
    _errors.listen((Object? message) {
      _failAll('worker exited: $message');
    });
  }

  void _failAll(String message) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(_WorkerException('NATIVE_WORKER_LOST', message));
      }
    }
    _pending.clear();
  }

  /// Opens the library and reports which optional entry points it exports.
  Future<Map<String, Object?>?> open(String path) async {
    final reply = await _send(<Object?>['open', path]);
    if (reply is Map<String, Object?>) return reply;
    if (reply is Map) return reply.cast<String, Object?>();
    return null;
  }

  Future<Object?> call(String symbol, NativeSignature signature, List<Object?> args) {
    return _send(<Object?>['call', symbol, signature.describe(), args]);
  }

  Future<Object?> emit(int event, int a, int b, double c) {
    return _send(<Object?>['emit', event, a, b, c]);
  }

  Future<Object?> _send(List<Object?> payload) async {
    final port = _port;
    if (_closed || port == null) {
      throw _WorkerException('NATIVE_NOT_LOADED', 'library worker is closed');
    }
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    port.send(<Object?>[id, ...payload]);
    return completer.future;
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _failAll('library worker closed');
    _inbox.close();
    _errors.close();
    _isolate.kill(priority: Isolate.immediate);
  }
}

/// An error that crossed the isolate boundary, carrying the Mio error code.
class _WorkerException implements Exception {
  const _WorkerException(this.code, this.message);
  final String code;
  final String message;

  @override
  String toString() => '$code: $message';
}

/// Worker isolate body. Everything below runs off the UI thread.
void _workerMain(List<Object?> args) {
  final send = args[0] as SendPort;
  final inbox = ReceivePort();
  send.send(inbox.sendPort);

  DynamicLibrary? library;

  inbox.listen((Object? message) {
    if (message is! List || message.isEmpty) return;
    final id = message[0] as int;
    final op = message.length > 1 ? message[1] : null;
    try {
      switch (op) {
        case 'open':
          library = DynamicLibrary.open(message[2] as String);
          send.send(<Object?>[
            id,
            'ok',
            <String, Object?>{
              'entry': library!.providesSymbol('mio_start'),
              'event': library!.providesSymbol('mio_event'),
              'stop': library!.providesSymbol('mio_stop'),
            },
          ]);
        case 'call':
          final symbol = message[2] as String;
          final signature = NativeSignature.parse(message[3] as String);
          final values = (message[4] as List).cast<Object?>();
          final result = invokeNative(library!, symbol, signature, values);
          send.send(<Object?>[id, 'ok', result]);
        case 'emit':
          library!
              .lookupFunction<Void Function(Int32, Int64, Int64, Double),
                  void Function(int, int, int, double)>('mio_event')(
            message[2] as int,
            message[3] as int,
            message[4] as int,
            message[5] as double,
          );
          send.send(<Object?>[id, 'ok', null]);
        default:
          send.send(<Object?>[id, 'error', 'METHOD_NOT_FOUND', 'unknown worker op: $op']);
      }
    } on NativeSignatureException catch (error) {
      send.send(<Object?>[id, 'error', 'NATIVE_BAD_SIGNATURE', error.message]);
    } on ArgumentError catch (error) {
      send.send(<Object?>[id, 'error', 'NATIVE_SYMBOL_NOT_FOUND', '$error']);
    } on Object catch (error) {
      send.send(<Object?>[id, 'error', 'NATIVE_CALL_FAILED', '$error']);
    }
  });
}
