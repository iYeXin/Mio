import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'errors.dart';
import 'launch_args.dart';

/// Maximum number of bytes carried by one `process.stdout` / `process.stderr`
/// event. Larger writes from the child are split, so a chatty process cannot
/// turn a single read into a multi-megabyte JSON-RPC message.
const int mioProcessChunkSize = 16 * 1024;

/// Maximum number of sidecar processes a single app may run at once. This is a
/// guard rail against a bug in app code fork-bombing the machine, not a
/// security boundary.
const int mioProcessLimit = 32;

typedef MioProcessEventSink = void Function(String name, Object? data);

/// Splits [bytes] into bounded, base64 encoded chunks.
///
/// The page concatenates the decoded chunks; chunk boundaries carry no meaning.
Iterable<String> mioProcessChunks(List<int> bytes) sync* {
  for (var offset = 0; offset < bytes.length; offset += mioProcessChunkSize) {
    final end = offset + mioProcessChunkSize;
    yield base64Encode(
      bytes.sublist(offset, end > bytes.length ? bytes.length : end),
    );
  }
}

class _MioProcess {
  _MioProcess({
    required this.id,
    required this.pid,
    required this.executable,
    required this.process,
  });

  final String id;
  final int pid;
  final String executable;
  final Process process;
  bool stdinClosed = false;
}

/// Starts and supervises sidecar processes (`process.*` Mio API).
///
/// Mio does not provide a native plugin mechanism. The only supported way to
/// run C/C++/Rust code is for the app to ship an executable and talk to it over
/// its own protocol; this class is the "start a process and give me stdio"
/// half of that contract and nothing more.
///
/// Executables must live inside one of [roots] (the install directory and the
/// app data directory). Paths are canonicalised before the check so a symlink
/// cannot hop out of those roots.
class MioProcessManager {
  MioProcessManager({
    required Iterable<String> roots,
    required this.emit,
  }) : _roots = roots
            .map((root) => p.normalize(p.absolute(root)))
            .toList(growable: false);

  final List<String> _roots;
  final MioProcessEventSink emit;
  final Map<String, _MioProcess> _running = <String, _MioProcess>{};
  List<String>? _canonicalRoots;
  var _nextId = 0;

  /// Directories an executable (or a working directory) may live in.
  List<String> get roots => List<String>.unmodifiable(_roots);

  /// Number of currently running sidecars.
  int get runningCount => _running.length;

  /// Dispatches a `process.*` JSON-RPC method.
  ///
  /// Async on purpose: unknown methods must reject the returned future instead
  /// of throwing synchronously, so the bridge can map them to JSON-RPC errors.
  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'process.spawn':
        return spawn(params);
      case 'process.write':
        return write(params);
      case 'process.closeStdin':
        return closeStdin(params);
      case 'process.kill':
        return kill(params);
      case 'process.list':
        return list();
      case 'process.exec':
        return exec(params);
      case 'process.pid':
        return appPid();
      case 'process.env':
        return environment(params);
      case 'process.args':
        return launchArgs();
      default:
        throw MioApiException(
          'METHOD_NOT_FOUND',
          'Unknown Mio process method: $method',
        );
    }
  }

  /// Runs a command to completion and returns its output.
  ///
  /// `command` goes through `cmd.exe /c` (a real shell command); `path` + `args`
  /// starts an executable directly, and `path` still obeys the sandbox roots.
  Future<Object?> exec(Map<String, dynamic> params) async {
    final command = _optionalString(params, 'command');
    final requestedPath = _optionalString(params, 'path');
    if (command == null && requestedPath == null) {
      throw MioApiException(
        'BAD_REQUEST',
        'exec needs either command or path',
      );
    }

    final String executable;
    final List<String> args;
    final String? requestedCwd = _optionalString(params, 'cwd');
    final String cwd;
    if (command != null) {
      executable = Platform.environment['COMSPEC'] ?? 'cmd.exe';
      args = <String>['/c', command];
      cwd = requestedCwd == null
          ? Platform.environment['SystemRoot'] ?? Directory.current.path
          : await resolveDirectory(requestedCwd);
    } else {
      executable = await resolveExecutable(requestedPath!);
      args = _optionalStringList(params, 'args');
      cwd = requestedCwd == null
          ? p.dirname(executable)
          : await resolveDirectory(requestedCwd);
    }

    final maxOutput = _optionalInt(params, 'maxOutputBytes') ?? 1024 * 1024;
    final timeoutMs = (_optionalInt(params, 'timeoutMs') ?? 30000).clamp(1000, 300000);
    final started = DateTime.now();

    final Process process;
    try {
      process = await Process.start(
        executable,
        args,
        workingDirectory: cwd,
        environment: _optionalStringMap(params, 'env'),
        includeParentEnvironment: true,
        runInShell: false,
      );
    } on ProcessException catch (error) {
      throw MioApiException(
        'PROCESS_START_FAILED',
        error.message.isEmpty ? 'Could not start process' : error.message,
        {'path': executable},
      );
    }

    final stdout = BytesBuilder(copy: false);
    final stderr = BytesBuilder(copy: false);
    var truncated = false;

    void collect(BytesBuilder target, List<int> chunk) {
      if (target.length >= maxOutput) {
        truncated = true;
        return;
      }
      final remaining = maxOutput - target.length;
      target.add(chunk.length <= remaining ? chunk : chunk.sublist(0, remaining));
      if (chunk.length > remaining) truncated = true;
    }

    final stdoutDone = process.stdout.forEach((chunk) => collect(stdout, chunk));
    final stderrDone = process.stderr.forEach((chunk) => collect(stderr, chunk));

    final input = _optionalString(params, 'stdin');
    if (input != null) {
      process.stdin.write(input);
    }
    await process.stdin.close();

    final exitCode = await Future.any<int>([
      process.exitCode,
      Future<int>.delayed(Duration(milliseconds: timeoutMs), () {
        procKill(process);
        return -1;
      }),
    ]);
    await Future.wait<void>([stdoutDone, stderrDone]);

    final durationMs = DateTime.now().difference(started).inMilliseconds;
    if (exitCode == -1) {
      throw MioApiException(
        'PROCESS_TIMEOUT',
        'Command did not finish within ${timeoutMs}ms',
        {'timeoutMs': timeoutMs},
      );
    }

    return <String, Object?>{
      'code': exitCode,
      'pid': process.pid,
      'stdout': utf8.decode(stdout.takeBytes(), allowMalformed: true),
      'stderr': utf8.decode(stderr.takeBytes(), allowMalformed: true),
      'durationMs': durationMs,
      'truncated': truncated,
    };
  }

  /// The application's own process id.
  Object appPid() => <String, Object?>{'pid': pid};

  /// Environment variables of the application process.
  Object environment([Map<String, dynamic> params = const {}]) {
    final names = _optionalStringList(params, 'names');
    final all = Platform.environment;
    if (names.isEmpty) return <String, Object?>{'env': all};
    return <String, Object?>{
      'env': <String, Object?>{
        for (final name in names)
          if (all.containsKey(name)) name: all[name],
      },
    };
  }

  /// The application's own launch arguments.
  Object launchArgs() => <String, Object?>{'args': mioLaunchArguments()};

  int? _optionalInt(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    return null;
  }

  void procKill(Process process) {
    try {
      process.kill();
    } catch (_) {
      // The process may already be gone.
    }
  }

  Future<Object?> spawn(Map<String, dynamic> params) async {
    if (_running.length >= mioProcessLimit) {
      throw MioApiException(
        'PROCESS_LIMIT',
        'Too many sidecar processes (limit $mioProcessLimit)',
        {'limit': mioProcessLimit},
      );
    }

    final executable = await resolveExecutable(_requiredString(params, 'path'));
    final args = _optionalStringList(params, 'args');
    final requestedCwd = _optionalString(params, 'cwd');
    final cwd = requestedCwd == null
        ? p.dirname(executable)
        : await resolveDirectory(requestedCwd);
    final env = _optionalStringMap(params, 'env');

    final Process process;
    try {
      process = await Process.start(
        executable,
        args,
        workingDirectory: cwd,
        environment: env,
        includeParentEnvironment: true,
        runInShell: false,
      );
    } on ProcessException catch (error) {
      throw MioApiException(
        'PROCESS_START_FAILED',
        error.message.isEmpty ? 'Could not start process' : error.message,
        {'path': executable},
      );
    }

    final id = (_nextId++).toString();
    final handle = _MioProcess(
      id: id,
      pid: process.pid,
      executable: executable,
      process: process,
    );
    _running[id] = handle;

    process.stdout.listen(
      (chunk) => _emitData(handle, 'stdout', chunk),
      onError: (Object error) => _emitStreamError(handle, 'stdout', error),
      cancelOnError: false,
    );
    process.stderr.listen(
      (chunk) => _emitData(handle, 'stderr', chunk),
      onError: (Object error) => _emitStreamError(handle, 'stderr', error),
      cancelOnError: false,
    );
    process.stdin.done.catchError((Object error) {
      handle.stdinClosed = true;
      _emitStreamError(handle, 'stdin', error);
    });
    unawaited(_watchExit(handle));

    return {
      'id': id,
      'pid': process.pid,
      'executable': executable,
      'cwd': cwd,
    };
  }

  Future<Object?> write(Map<String, dynamic> params) async {
    final handle = _handle(params);
    final data = _requiredString(params, 'data', allowEmpty: true);
    if (handle.stdinClosed) {
      throw MioApiException(
        'PROCESS_STDIN_CLOSED',
        'stdin is already closed for process ${handle.id}',
        {'id': handle.id},
      );
    }
    final List<int> bytes;
    try {
      bytes = base64Decode(data);
    } on FormatException {
      throw const MioApiException('BAD_REQUEST', 'data is not valid base64');
    }
    try {
      // Writes are queued, not flushed: a sidecar that stops reading its stdin
      // must not block the JSON-RPC call that produced the bytes.
      handle.process.stdin.add(bytes);
    } on StateError {
      handle.stdinClosed = true;
      throw MioApiException(
        'PROCESS_STDIN_CLOSED',
        'stdin is already closed for process ${handle.id}',
        {'id': handle.id},
      );
    }
    return null;
  }

  Future<Object?> closeStdin(Map<String, dynamic> params) async {
    final handle = _handle(params);
    if (handle.stdinClosed) return null;
    handle.stdinClosed = true;
    try {
      await handle.process.stdin.close();
    } on Object catch (error) {
      throw MioApiException(
        'PROCESS_WRITE_FAILED',
        'Could not close stdin: $error',
        {'id': handle.id},
      );
    }
    return null;
  }

  Future<Object?> kill(Map<String, dynamic> params) async {
    final handle = _handle(params);
    final name = _optionalString(params, 'signal') ?? 'term';
    final signal = switch (name) {
      'term' => ProcessSignal.sigterm,
      'kill' => ProcessSignal.sigkill,
      _ => throw MioApiException(
          'BAD_REQUEST',
          'Unknown signal: $name (expected "term" or "kill")',
        ),
    };

    final killed = handle.process.kill(signal);
    if (!await _waitForExit(handle, const Duration(seconds: 5))) {
      handle.process.kill(ProcessSignal.sigkill);
      await _waitForExit(handle, const Duration(seconds: 2));
    }
    return {'id': handle.id, 'pid': handle.pid, 'killed': killed};
  }

  Future<Object?> list() async => <Map<String, Object?>>[
        for (final handle in _running.values)
          {
            'id': handle.id,
            'pid': handle.pid,
            'executable': handle.executable,
          },
      ];

  /// Best-effort cleanup used when the app quits or the runtime shuts down.
  ///
  /// Grandchildren are not tracked: Windows has no portable way to kill a whole
  /// tree without shelling out, and Mio does not shell out.
  Future<void> killAll({Duration grace = const Duration(seconds: 3)}) async {
    final handles = _running.values.toList(growable: false);
    if (handles.isEmpty) return;
    for (final handle in handles) {
      handle.process.kill(ProcessSignal.sigterm);
    }
    final deadline = DateTime.now().add(grace);
    for (final handle in handles) {
      final remaining = deadline.difference(DateTime.now());
      if (remaining <= Duration.zero ||
          !await _waitForExit(handle, remaining)) {
        handle.process.kill(ProcessSignal.sigkill);
      }
    }
  }

  /// Resolves [requested] to a canonical path of a regular file inside
  /// [roots].
  ///
  /// Relative paths are resolved against each root in order; absolute paths
  /// must already point inside a root once symlinks are resolved.
  Future<String> resolveExecutable(String requested) async {
    final candidates = _candidates(requested);
    for (final candidate in candidates) {
      final type = await FileSystemEntity.type(candidate, followLinks: true);
      if (type != FileSystemEntityType.file) continue;
      final real = await _realPath(candidate);
      if (!await _insideRoots(real)) {
        throw MioApiException(
          'PROCESS_FORBIDDEN',
          'Executable resolves outside the allowed directories',
          {'path': candidate, 'resolved': real, 'roots': roots},
        );
      }
      return real;
    }
    throw MioApiException(
      'PROCESS_NOT_FOUND',
      'Executable not found: $requested',
      {'tried': candidates, 'roots': roots},
    );
  }

  /// Same rules as [resolveExecutable], for the child's working directory.
  Future<String> resolveDirectory(String requested) async {
    final candidates = _candidates(requested);
    for (final candidate in candidates) {
      final type = await FileSystemEntity.type(candidate, followLinks: true);
      if (type != FileSystemEntityType.directory) continue;
      final real = await _realPath(candidate);
      if (!await _insideRoots(real)) {
        throw MioApiException(
          'PROCESS_FORBIDDEN',
          'cwd resolves outside the allowed directories',
          {'path': candidate, 'resolved': real, 'roots': roots},
        );
      }
      return real;
    }
    throw MioApiException(
      'PROCESS_NOT_FOUND',
      'Directory not found: $requested',
      {'tried': candidates, 'roots': roots},
    );
  }

  List<String> _candidates(String requested) {
    final normalized = p.normalize(requested.replaceAll('\\', '/'));
    if (normalized.isEmpty || normalized == '.') return const <String>[];
    if (p.isAbsolute(normalized)) return <String>[normalized];
    return <String>[
      for (final root in _roots) p.normalize(p.join(root, normalized)),
    ];
  }

  Future<void> _watchExit(_MioProcess handle) async {
    var code = -1;
    try {
      code = await handle.process.exitCode;
    } on Object {
      // exitCode normally does not fail; if it does the code stays unknown.
    }
    _running.remove(handle.id);
    emit('process.exit', {
      'id': handle.id,
      'pid': handle.pid,
      'code': code,
      'signal': null,
      'executable': handle.executable,
    });
  }

  Future<bool> _waitForExit(_MioProcess handle, Duration timeout) async {
    try {
      await handle.process.exitCode.timeout(timeout);
      return true;
    } on TimeoutException {
      return false;
    }
  }

  void _emitData(_MioProcess handle, String stream, List<int> chunk) {
    if (chunk.isEmpty) return;
    for (final data in mioProcessChunks(chunk)) {
      emit('process.$stream', {
        'id': handle.id,
        'pid': handle.pid,
        'data': data,
      });
    }
  }

  void _emitStreamError(_MioProcess handle, String stream, Object error) {
    emit('process.error', {
      'id': handle.id,
      'pid': handle.pid,
      'stream': stream,
      'message': '$error',
    });
  }

  _MioProcess _handle(Map<String, dynamic> params) {
    final id = _requiredString(params, 'id');
    final handle = _running[id];
    if (handle == null) {
      throw MioApiException(
        'PROCESS_NOT_FOUND',
        'No running process with id $id',
        {'id': id},
      );
    }
    return handle;
  }

  Future<List<String>> _resolvedRoots() async {
    final cached = _canonicalRoots;
    if (cached != null) return cached;
    final resolved = <String>[
      for (final root in _roots) await _realPath(root),
    ];
    return _canonicalRoots = resolved;
  }

  Future<bool> _insideRoots(String path) async {
    for (final root in await _resolvedRoots()) {
      if (p.equals(root, path) || p.isWithin(root, path)) return true;
    }
    return false;
  }

  Future<String> _realPath(String path) async {
    try {
      return _stripExtendedPrefix(await File(path).resolveSymbolicLinks());
    } on FileSystemException {
      return p.normalize(path);
    }
  }

  /// `resolveSymbolicLinks` returns `\\?\C:\...` (or `\\?\UNC\...`) on Windows;
  /// strip the prefix so containment checks compare against plain roots.
  static String _stripExtendedPrefix(String path) {
    if (path.startsWith(r'\\?\UNC\')) return '\\\\${path.substring(8)}';
    if (path.startsWith(r'\\?\')) return path.substring(4);
    return path;
  }

  static String _requiredString(
    Map<String, dynamic> params,
    String key, {
    bool allowEmpty = false,
  }) {
    final value = params[key];
    if (value is! String || (!allowEmpty && value.isEmpty)) {
      throw MioApiException('BAD_REQUEST', 'Missing string parameter: $key');
    }
    return value;
  }

  static String? _optionalString(Map<String, dynamic> params, String key) {
    final value = params[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  static List<String> _optionalStringList(
    Map<String, dynamic> params,
    String key,
  ) {
    final value = params[key];
    if (value == null) return const <String>[];
    if (value is! List) {
      throw MioApiException('BAD_REQUEST', '$key must be an array of strings');
    }
    final result = <String>[];
    for (final item in value) {
      if (item is! String) {
        throw MioApiException('BAD_REQUEST', '$key must be an array of strings');
      }
      result.add(item);
    }
    return result;
  }

  static Map<String, String>? _optionalStringMap(
    Map<String, dynamic> params,
    String key,
  ) {
    final value = params[key];
    if (value == null) return null;
    if (value is! Map) {
      throw MioApiException('BAD_REQUEST', '$key must be an object of strings');
    }
    final result = <String, String>{};
    value.forEach((Object? name, Object? item) {
      if (name is! String || item is! String) {
        throw MioApiException('BAD_REQUEST', '$key must be an object of strings');
      }
      result[name] = item;
    });
    return result;
  }
}
