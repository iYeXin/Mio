import 'dart:async';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:path/path.dart' as p;

import 'asar.dart';
import 'errors.dart';
import 'native_binary.dart';
import 'native_signatures.dart';
import 'native_worker.dart';

/// Contract for the optional entry point a library may export:
///
/// ```c
/// typedef void (*mio_sink_fn)(int32_t event, int64_t a, int64_t b, double c);
/// int32_t mio_start(mio_sink_fn sink, const char* config);
/// ```
///
/// The shell calls [mio_start] on a worker isolate so a blocking entry cannot
/// freeze the UI. Events raised by `sink` are forwarded to the page as
/// `native.event`.
typedef MioSinkNative = Void Function(Int32, Int64, Int64, Double);
typedef MioStartNative =
    Int32 Function(Pointer<NativeFunction<MioSinkNative>>, Pointer<Utf8>);
typedef MioStartDart =
    int Function(Pointer<NativeFunction<MioSinkNative>>, Pointer<Utf8>);

typedef MioNativeEventSink = void Function(String name, Object? data);

/// Short name for the ABI this process is running as.
String currentAbiName() {
  switch (Abi.current()) {
    case Abi.androidArm:
      return 'arm';
    case Abi.androidArm64:
      return 'arm64';
    case Abi.androidIA32:
      return 'x86';
    case Abi.androidX64:
      return 'x64';
    case Abi.windowsArm64:
      return 'arm64';
    case Abi.windowsIA32:
      return 'x86';
    case Abi.windowsX64:
      return 'x64';
    default:
      return Abi.current().toString();
  }
}

class _NativeLibrary {
  _NativeLibrary({
    required this.handle,
    required this.name,
    required this.asarPath,
    required this.filePath,
    required this.worker,
    required this.hasEntry,
    required this.hasEvent,
    required this.hasStop,
    required this.abi,
  });

  final String handle;
  final String name;
  final String asarPath;
  final String filePath;

  /// All FFI calls run on this worker isolate, never on the UI isolate.
  final NativeWorker worker;
  final bool hasEntry;
  final bool hasEvent;
  final bool hasStop;
  final String abi;
  NativeCallable<MioSinkNative>? sink;
  bool started = false;

  Map<String, Object?> describe() => <String, Object?>{
    'handle': handle,
    'abi': abi,
    'name': name,
    'path': asarPath,
    'file': filePath,
    'entry': hasEntry,
    'started': started,
  };
}

class _EntryOutcome {
  const _EntryOutcome({this.code, this.running = false, this.error});

  final int? code;
  final bool running;
  final String? error;
}

/// Loads native libraries out of the app archive and calls into them.
///
/// This is intentionally not a plugin system: there is no ABI negotiation, no
/// registration, no lifecycle beyond "load" and an optional `mio_start`. The
/// supported call shapes are a fixed scalar set (see [supportedSignatures]) and
/// events travel to the page as scalars tagged with a caller-chosen id.
class MioNativeManager {
  MioNativeManager({
    this.asar,
    required this.extractRoot,
    required this.platformName,
    required this.emit,
    String? abiName,
  }) : abiName = abiName ?? currentAbiName();

  final AsarArchive? asar;
  final Directory extractRoot;
  final String platformName;
  final String abiName;
  final MioNativeEventSink emit;

  final Map<String, _NativeLibrary> _libraries = <String, _NativeLibrary>{};
  final Map<String, Future<Object?>> _loading = <String, Future<Object?>>{};
  var _nextHandle = 1;

  bool get supported => platformName == 'android' || platformName == 'windows';

  /// Whether `load` can work right now: right platform and a packaged build.
  bool get available => supported && asar != null;

  String get extension => platformName == 'windows' ? 'dll' : 'so';

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'native.load':
        return await load(params);
      case 'native.start':
        return await start(params);
      case 'native.stop':
        return await stop(params);
      case 'native.call':
        return callScalar(params);
      case 'native.emit':
        return emitEvent(params);
      case 'native.list':
        return list();
      default:
        throw MioApiException('METHOD_NOT_FOUND', 'Unknown Mio native method: $method');
    }
  }

  Future<Object?> load(Map<String, dynamic> params) async {
    if (!supported) {
      throw MioApiException(
        'NATIVE_UNAVAILABLE',
        'native libraries are not supported on $platformName',
      );
    }
    final archive = asar;
    if (archive == null) {
      throw const MioApiException(
        'NATIVE_UNAVAILABLE',
        'native libraries are only available in a packaged build; dev mode serves '
            'the page from a dev server and has no app archive',
      );
    }

    final name = _libraryName(params);
    final existing = _libraries.values.where((library) => library.name == name);
    if (existing.isNotEmpty) return existing.first.describe();

    // Two concurrent loads of the same library share one extraction.
    final inFlight = _loading[name];
    if (inFlight != null) return await inFlight;

    final future = _load(name, archive);
    _loading[name] = future;
    try {
      return await future;
    } finally {
      _loading.remove(name);
    }
  }

  Future<Object?> _load(String name, AsarArchive archive) async {
    final asarPath = 'native/$abiName/$name.$extension';
    if (!archive.has(asarPath)) {
      throw MioApiException(
        'NATIVE_NOT_FOUND',
        'Native library is not in the app content: $asarPath',
        {'path': asarPath, 'abi': abiName, 'hint': 'pack it under dist/$asarPath'},
      );
    }

    final span = archive.spanOf(asarPath);
    final target = File(p.join(extractRoot.path, abiName, '$name.$extension'));
    await target.parent.create(recursive: true);
    final marker = File('${target.path}.mio');
    final expectedMarker = nativeCacheMarker(
      offset: span.offset,
      size: span.size,
      archiveModifiedMs: archive.modifiedMs,
    );

    // Skip the copy when the extracted file came from this exact archive entry.
    // Comparing the archive's mtime with the entry position catches rebuilds
    // even when the library size is unchanged.
    var cached = false;
    if (await target.exists() && await target.length() == span.size && await marker.exists()) {
      cached = (await marker.readAsString()).trim() == expectedMarker;
    }
    if (!cached) {
      await _extract(archive, asarPath, target, marker, expectedMarker);
    }

    // Validate what is actually on disk: it is the file the loader will map.
    final NativeBinaryInfo info;
    try {
      info = await _inspectFile(target);
    } on NativeBinaryException catch (error) {
      throw MioApiException('NATIVE_INVALID', error.message, {'path': asarPath});
    }
    if (info.abi != abiName) {
      throw MioApiException(
        'NATIVE_INVALID',
        'Library targets ${info.abi ?? 'an unknown ABI'} but this build runs $abiName',
        {'path': asarPath, 'expected': abiName, 'found': info.abi},
      );
    }

    final NativeWorker worker;
    try {
      worker = await NativeWorker.start(target.path);
    } on Object catch (error) {
      throw MioApiException(
        'NATIVE_LOAD_FAILED',
        describeLoadFailure('$error', abi: abiName),
        {'path': target.path},
      );
    }

    final handle = '${_nextHandle++}';
    final entry = _NativeLibrary(
      handle: handle,
      name: name,
      asarPath: asarPath,
      filePath: target.path,
      worker: worker,
      hasEntry: worker.openResult['entry'] == true,
      hasEvent: worker.openResult['event'] == true,
      hasStop: worker.openResult['stop'] == true,
      abi: abiName,
    );
    _libraries[handle] = entry;
    emit('native.loaded', entry.describe());
    return entry.describe();
  }

  /// Streams the library out of the archive.
  ///
  /// A whole-entry read would put the entire `.so`/`.dll` on the heap; a 60 MB
  /// ffmpeg build would spike memory and take a GC pause. The copy is chunked
  /// and the marker is written only after the file is complete.
  Future<void> _extract(
    AsarArchive archive,
    String asarPath,
    File target,
    File marker,
    String markerValue,
  ) async {
    final sink = target.openWrite();
    try {
      await sink.addStream(archive.readStream(asarPath));
      await sink.close();
    } on Object catch (error) {
      try {
        await sink.close();
      } on Object {
        // The sink may already be closed.
      }
      if (await target.exists()) await target.delete();
      throw MioApiException(
        'NATIVE_LOAD_FAILED',
        'Could not extract $asarPath: $error',
        {'path': asarPath},
      );
    }
    await marker.writeAsString(markerValue, flush: true);
  }

  /// Reads only the header area of the extracted file.
  Future<NativeBinaryInfo> _inspectFile(File file) async {
    final length = await file.length();
    final head = BytesBuilder(copy: false);
    await for (final chunk in file.openRead(0, length < 4096 ? length : 4096)) {
      head.add(chunk);
    }
    return inspectNativeBinary(head.takeBytes());
  }

  Future<Object?> start(Map<String, dynamic> params) async {
    final library = _library(params);
    if (!library.hasEntry) {
      throw MioApiException(
        'NATIVE_NO_ENTRY',
        'Library ${library.name} does not export mio_start',
        {'handle': library.handle},
      );
    }
    if (library.started) {
      throw MioApiException(
        'NATIVE_ALREADY_STARTED',
        'Library ${library.name} was already started',
        {'handle': library.handle},
      );
    }
    library.started = true;

    final sink = library.sink ??= NativeCallable<MioSinkNative>.listener(
      (int event, int a, int b, double c) {
        emit('native.event', <String, Object?>{
          'handle': library.handle,
          'event': event,
          'a': a,
          'b': b,
          'c': c,
        });
      },
    );

    final config = _optionalString(params, 'config') ?? '';
    final outcome = await _runEntry(
      library.filePath,
      sink.nativeFunction.address,
      config,
    );
    if (outcome.error != null) {
      library.started = false;
      throw MioApiException(
        'NATIVE_START_FAILED',
        outcome.error!,
        {'handle': library.handle},
      );
    }
    return {'handle': library.handle, 'code': outcome.code, 'running': outcome.running};
  }

  /// Asks a started library to wind down through its optional `mio_stop`
  /// export, then forgets that it is running.
  ///
  /// The library itself stays loaded: Dart cannot unload it, and native threads
  /// may still be finishing.
  Future<Object?> stop(Map<String, dynamic> params) async {
    final library = _library(params);
    if (!library.started) {
      return {'handle': library.handle, 'stopped': false, 'reason': 'not started'};
    }
    library.started = false;
    if (!library.hasStop) {
      return {'handle': library.handle, 'stopped': false, 'reason': 'no mio_stop'};
    }
    final outcome = await _runStop(library.filePath);
    return {
      'handle': library.handle,
      'stopped': outcome.error == null,
      if (outcome.running) 'timedOut': true,
      if (outcome.error != null) 'reason': outcome.error,
    };
  }

  Future<Object?> callScalar(Map<String, dynamic> params) async {
    final library = _library(params);
    final symbol = _requiredString(params, 'symbol');
    final signatureText = _requiredString(params, 'signature');

    final NativeSignature signature;
    try {
      signature = NativeSignature.parse(signatureText);
    } on NativeSignatureException catch (error) {
      throw MioApiException('NATIVE_BAD_SIGNATURE', error.message);
    }

    final raw = params['args'];
    final List<Object?> values;
    if (raw == null) {
      values = const <Object?>[];
    } else if (raw is List) {
      values = raw.cast<Object?>();
    } else {
      throw const MioApiException('BAD_REQUEST', 'args must be an array');
    }

    final List<Object?> coerced;
    try {
      coerced = signature.coerce(values);
    } on NativeSignatureException catch (error) {
      throw MioApiException('NATIVE_BAD_SIGNATURE', error.message);
    }

    try {
      // Runs on the library's worker isolate: a slow export cannot freeze the
      // UI, and calls are serialized against each other.
      return await library.worker.call(symbol, signature, coerced);
    } on Object catch (error) {
      throw _mapWorkerError(error, library, symbol: symbol);
    }
  }

  /// Sends a scalar event into the library through the optional `mio_event`
  /// export. The reverse direction of the `mio_start` sink.
  Future<Object?> emitEvent(Map<String, dynamic> params) async {
    final library = _library(params);
    final event = _optionalInt(params, 'event') ?? 0;
    if (event < -2147483648 || event > 2147483647) {
      throw const MioApiException('BAD_REQUEST', 'event does not fit in i32');
    }
    final a = _optionalInt(params, 'a') ?? 0;
    final b = _optionalInt(params, 'b') ?? 0;
    final c = _optionalDouble(params, 'c') ?? 0.0;

    if (!library.hasEvent) {
      throw MioApiException(
        'NATIVE_NO_EVENT_HANDLER',
        'Library ${library.name} does not export mio_event',
        {'handle': library.handle},
      );
    }
    try {
      await library.worker.emit(event, a, b, c);
    } on Object catch (error) {
      throw _mapWorkerError(error, library);
    }
    return null;
  }

  List<Map<String, Object?>> list() => <Map<String, Object?>>[
    for (final library in _libraries.values) library.describe(),
  ];

  /// Drops bookkeeping at shutdown. Loaded libraries stay mapped until the
  /// process exits — Dart has no way to unload them.
  ///
  /// Started libraries get a bounded `mio_stop` first so they can flush state;
  /// a library that blocks is abandoned rather than holding up the exit.
  ///
  /// Event sinks are deliberately *not* closed: their trampolines are alive
  /// because native threads may still hold them, and closing a callable that a
  /// thread is about to invoke would crash during shutdown instead of during
  /// use.
  Future<void> close() async {
    final started = _libraries.values
        .where((library) => library.started && library.hasStop)
        .toList(growable: false);
    for (final library in started) {
      library.started = false;
      await _runStop(library.filePath, timeout: const Duration(seconds: 1));
    }
    for (final library in _libraries.values) {
      library.sink = null;
      library.worker.close();
    }
    _libraries.clear();
  }

  /// Translates a worker-side failure into the public error shape.
  MioApiException _mapWorkerError(
    Object error,
    _NativeLibrary library, {
    String? symbol,
  }) {
    // The worker sends errors as "<code>: <message>" via _WorkerException.
    final text = '$error';
    final separator = text.indexOf(': ');
    if (separator > 0) {
      final code = text.substring(0, separator);
      final message = text.substring(separator + 2);
      if (code == 'NATIVE_SYMBOL_NOT_FOUND' && symbol != null) {
        return MioApiException(
          code,
          'Library ${library.name} has no symbol "$symbol"',
          {'handle': library.handle, 'symbol': symbol},
        );
      }
      return MioApiException(code, message, {'handle': library.handle});
    }
    return MioApiException(
      'NATIVE_CALL_FAILED',
      text,
      {'handle': library.handle},
    );
  }

  int? _optionalInt(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value == null) return null;
    if (value is int) return value;
    if (value is num) return value.toInt();
    throw MioApiException('BAD_REQUEST', '$key must be a number');
  }

  double? _optionalDouble(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value == null) return null;
    if (value is num) return value.toDouble();
    throw MioApiException('BAD_REQUEST', '$key must be a number');
  }

  _NativeLibrary _library(Map<String, dynamic> params) {
    final handle = _requiredString(params, 'handle');
    final library = _libraries[handle];
    if (library == null) {
      throw MioApiException(
        'NATIVE_NOT_LOADED',
        'No native library with handle $handle',
        {'handle': handle},
      );
    }
    return library;
  }

  String _libraryName(Map<String, dynamic> params) {
    final name = _requiredString(params, 'name');
    final valid = RegExp(r'^[A-Za-z0-9_-][A-Za-z0-9._-]*$');
    if (!valid.hasMatch(name) || name.contains('..') || name.length > 128) {
      throw MioApiException(
        'BAD_REQUEST',
        'Library name must match [A-Za-z0-9._-] and contain no "..": $name',
      );
    }
    return name;
  }

  String _requiredString(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is! String || value.isEmpty) {
      throw MioApiException('BAD_REQUEST', 'Missing string parameter: $key');
    }
    return value;
  }

  String? _optionalString(Map<String, dynamic> params, String key) {
    final value = params[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  Future<_EntryOutcome> _runEntry(
    String path,
    int sinkAddress,
    String config, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final receiver = ReceivePort();
    try {
      await Isolate.spawn(
        _entryMain,
        <Object?>[receiver.sendPort, path, sinkAddress, config],
        debugName: 'mio-native-entry',
      );
      final reply = await receiver.first.timeout(timeout);
      if (reply is List && reply.length == 2) {
        if (reply[0] == 'ok') {
          return _EntryOutcome(code: reply[1] as int);
        }
        return _EntryOutcome(error: '${reply[1]}');
      }
      return _EntryOutcome(error: 'unexpected entry reply: $reply');
    } on TimeoutException {
      // The entry did not return; it is presumably running its own loop. Keep
      // the isolate alive and tell the page it is running.
      return const _EntryOutcome(running: true);
    } finally {
      receiver.close();
    }
  }

  /// Calls `mio_stop` on a worker isolate; a library that blocks here must not
  /// hold up shutdown or the UI.
  Future<_EntryOutcome> _runStop(
    String path, {
    Duration timeout = const Duration(seconds: 2),
  }) async {
    final receiver = ReceivePort();
    try {
      await Isolate.spawn(
        _stopMain,
        <Object?>[receiver.sendPort, path],
        debugName: 'mio-native-stop',
      );
      final reply = await receiver.first.timeout(timeout);
      if (reply is List && reply.length == 2) {
        if (reply[0] == 'ok') return const _EntryOutcome(code: 0);
        return _EntryOutcome(error: '${reply[1]}');
      }
      return _EntryOutcome(error: 'unexpected stop reply: $reply');
    } on TimeoutException {
      return const _EntryOutcome(running: true);
    } finally {
      receiver.close();
    }
  }
}

/// Runs `mio_start` on a worker isolate so a blocking entry cannot freeze the UI.
void _entryMain(List<Object?> args) {
  final send = args[0] as SendPort;
  final path = args[1] as String;
  final sinkAddress = args[2] as int;
  final config = args[3] as String;
  try {
    final library = DynamicLibrary.open(path);
    final start = library.lookupFunction<MioStartNative, MioStartDart>('mio_start');
    final sink = Pointer<NativeFunction<MioSinkNative>>.fromAddress(sinkAddress);
    var configPointer = Pointer<Utf8>.fromAddress(0);
    if (config.isNotEmpty) configPointer = config.toNativeUtf8();
    try {
      final code = start(sink, configPointer);
      send.send(<Object?>['ok', code]);
    } finally {
      if (configPointer.address != 0) malloc.free(configPointer);
    }
  } on Object catch (error) {
    send.send(<Object?>['error', '$error']);
  }
}

void _stopMain(List<Object?> args) {
  final send = args[0] as SendPort;
  final path = args[1] as String;
  try {
    final library = DynamicLibrary.open(path);
    library.lookupFunction<Void Function(), void Function()>('mio_stop')();
    send.send(<Object?>['ok', 0]);
  } on Object catch (error) {
    send.send(<Object?>['error', '$error']);
  }
}
