import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:url_launcher/url_launcher.dart';

import 'app_manifest.dart';
import 'asar.dart';
import 'atomic_file.dart';
import 'errors.dart';
import 'native_manager.dart';
import 'process_manager.dart';
import 'window_actions.dart';

export 'errors.dart' show MioApiException;

const String mioApiVersion = '1.0.0';

/// Template build version. CI passes it with --dart-define so the shell reports
/// the same version as the release manifest.
const String mioTemplateVersion = String.fromEnvironment(
  'MIO_TEMPLATE_VERSION',
  defaultValue: '0.1.1',
);

final GlobalKey<NavigatorState> mioNavigatorKey = GlobalKey<NavigatorState>();

typedef MioEventSink = void Function(String name, Object? data);

class MioApi with WidgetsBindingObserver {
  MioApi({
    required this.manifest,
    required this.dataDir,
    required this.platformName,
    required this.windowActions,
    this.asar,
  }) : _fsRoot = Directory(p.join(dataDir.path, 'app')) {
    WidgetsBinding.instance.addObserver(this);
    _fsRoot.createSync(recursive: true);
    _processManager = MioProcessManager(
      // Sidecars may only live next to the installed executable or inside the
      // app data directory; nothing else is startable from the page.
      roots: <String>[p.dirname(Platform.resolvedExecutable), _fsRoot.path],
      emit: emit,
    );
    _nativeManager = MioNativeManager(
      asar: asar,
      extractRoot: Directory(p.join(dataDir.path, 'native')),
      platformName: platformName,
      emit: emit,
    );
  }

  final AppManifest manifest;
  final Directory dataDir;
  final String platformName;
  final WindowActions windowActions;
  final AsarArchive? asar;
  final Directory _fsRoot;

  late final MioProcessManager _processManager;
  late final MioNativeManager _nativeManager;

  /// When the shell finished starting; exposed for diagnostics.
  final DateTime _startedAt = DateTime.now().toUtc();

  MioEventSink? _eventSink;

  void bindEventSink(MioEventSink? sink) {
    _eventSink = sink;
  }

  void emit(String name, Object? data) {
    _eventSink?.call(name, data);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    emit('app.lifecycle', {'state': state.name});
  }

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    if (method.startsWith('process.')) {
      return await _processCall(method, params);
    }
    if (method.startsWith('native.')) {
      return await _nativeManager.call(method, params);
    }
    switch (method) {
      case 'ping':
        return {'pong': true, 'time': DateTime.now().toUtc().toIso8601String()};
      case 'app.info':
        return {
          'id': manifest.id,
          'name': manifest.name,
          'version': manifest.version,
          'title': manifest.title,
          'platform': platformName,
          'apiVersion': mioApiVersion,
          'templateVersion': mioTemplateVersion,
          // Dev mode has no app archive, so anything that reads from it is off.
          'dev': asar == null,
          'startedAt': _startedAt.toIso8601String(),
          'uptimeMs': DateTime.now().toUtc().difference(_startedAt).inMilliseconds,
          'features': {
            'native': _nativeManager.available,
            'process': platformName == 'windows',
            'window': windowActions.supported,
          },
        };
      case 'app.quit':
        await _quit();
        return null;
      case 'app.paths':
        return {
          // Everything the app owns. `app` is the only writable sandbox.
          'data': dataDir.path,
          'app': _fsRoot.path,
          'native': p.join(dataDir.path, 'native'),
          'install': p.dirname(Platform.resolvedExecutable),
          'temp': Directory.systemTemp.path,
        };
      case 'platform.info':
        return {
          'os': Platform.operatingSystem,
          'osVersion': Platform.operatingSystemVersion,
          'locale': Platform.localeName,
          'processors': Platform.numberOfProcessors,
          'platform': platformName,
          'abi': _nativeManager.abiName,
        };
      case 'window.state':
        return await windowActions.getState();
      case 'window.setTitle':
        return await _windowCall(
          () => windowActions.setTitle(_requiredString(params, 'title')),
        );
      case 'window.minimize':
        return await _windowCall(windowActions.minimize);
      case 'window.maximize':
        return await _windowCall(windowActions.maximize);
      case 'window.restore':
        return await _windowCall(windowActions.restore);
      case 'window.close':
        return await _windowCall(windowActions.close);
      case 'window.center':
        return await _windowCall(windowActions.center);
      case 'window.setFullScreen':
        return await _windowCall(
          () => windowActions.setFullScreen(params['fullScreen'] == true),
        );
      case 'window.setAlwaysOnTop':
        return await _windowCall(
          () => windowActions.setAlwaysOnTop(params['alwaysOnTop'] == true),
        );
      case 'window.setSize':
        return await _windowCall(
          () => windowActions.setSize(
            _requiredInt(params, 'width'),
            _requiredInt(params, 'height'),
          ),
        );
      case 'window.moveTo':
        return await _windowCall(
          () => windowActions.moveTo(
            _requiredInt(params, 'x'),
            _requiredInt(params, 'y'),
          ),
        );
      case 'dialog.openFile':
        return await _openFile(params);
      case 'dialog.openDirectory':
        return await _openDirectory();
      case 'dialog.saveFile':
        return await _saveFile(params);

      case 'fs.readText':
        return await _readText(params);
      case 'fs.writeText':
        return await _writeText(params);
      case 'fs.appendText':
        return await _appendText(params);

      case 'fs.list':
        return await _list(params);
      case 'fs.stat':
        return await _stat(params);
      case 'fs.mkdir':
        return await _mkdir(params);
      case 'fs.remove':
        return await _remove(params);
      case 'fs.rename':
        return await _rename(params);
      case 'fs.exists':
        return await _exists(params);
      case 'clipboard.readText':
        return (await Clipboard.getData(Clipboard.kTextPlain))?.text;
      case 'clipboard.writeText':
        await Clipboard.setData(
          ClipboardData(text: _requiredString(params, 'text')),
        );
        return null;
      case 'shell.openExternal':
        return await _openExternal(params);
      case 'shell.openPath':
        return await _openPath(params);
      case 'shell.reveal':
        return await _reveal(params);
      case 'app.log':
        return await _log(params);
      default:
        throw MioApiException(
          'METHOD_NOT_FOUND',
          'Unknown Mio API method: $method',
        );
    }
  }

  Future<Object?> _processCall(
    String method,
    Map<String, dynamic> params,
  ) async {
    // Mio does not ship a process API on Android: there is no supported way to
    // exec a bundled binary there, so promising it would be a lie.
    if (platformName != 'windows') {
      throw MioApiException(
        'UNSUPPORTED',
        'process APIs are only available on Windows (running on $platformName)',
      );
    }
    return await _processManager.call(method, params);
  }

  /// Stop sidecars and detach from the app lifecycle. Called on shutdown.
  Future<void> shutdown() async {
    WidgetsBinding.instance.removeObserver(this);
    bindEventSink(null);
    await _nativeManager.close();
    await _processManager.killAll();
  }

  Future<Object?> _windowCall(Future<void> Function() action) async {
    if (!windowActions.supported) {
      throw MioApiException(
        'UNSUPPORTED',
        'window APIs are not supported on this platform',
      );
    }
    try {
      await action();
      return null;
    } on WindowActionException catch (error) {
      throw MioApiException('WINDOW_ERROR', error.message);
    }
  }

  Future<void> _quit() async {
    await _processManager.killAll();
    if (windowActions.supported) {
      await windowActions.close();
      return;
    }
    await SystemNavigator.pop();
  }

  Future<Object?> _openFile(Map<String, dynamic> params) async {
    final extensions = _optionalStringList(params, 'extensions');
    final groups = extensions == null || extensions.isEmpty
        ? const <XTypeGroup>[XTypeGroup(label: 'Files')]
        : <XTypeGroup>[
            XTypeGroup(
              label: 'Files',
              extensions: extensions.map((value) => value.replaceFirst('.', '')).toList(),
            ),
          ];
    final file = await openFile(acceptedTypeGroups: groups);
    return file?.path;
  }

  Future<Object?> _saveFile(Map<String, dynamic> params) async {
    final suggestedName = _optionalString(params, 'suggestedName');
    final location = await getSaveLocation(suggestedName: suggestedName);
    return location?.path;
  }

  Future<Object?> _openDirectory() async {
    final path = await getDirectoryPath();
    return path;
  }

  String _resolvePath(String value) {
    final normalized = p.normalize(value.replaceAll('\\', '/'));
    if (p.isAbsolute(normalized)) {
      throw MioApiException('FS_FORBIDDEN', 'Absolute paths are not allowed');
    }
    final full = p.normalize(p.join(_fsRoot.path, normalized));
    if (full != _fsRoot.path && !p.isWithin(_fsRoot.path, full)) {
      throw MioApiException('FS_FORBIDDEN', 'Path escapes the app data directory');
    }
    return full;
  }

  /// Resolve a client-supplied path against the app data directory.
  ///
  /// Exposed for the HTTP blob endpoint so both transports share exactly the
  /// same path rules. Throws MioApiException on any escape attempt.
  String resolveDataPath(String value) => _resolvePath(value);

  Future<Object?> _readText(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    try {
      return await File(path).readAsString();
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
  }

  Future<Object?> _writeText(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    final text = _requiredString(params, 'text', allowEmpty: true);
    try {
      await atomicWriteBytes(File(path), utf8.encode(text));
      return null;
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
  }



  /// Appends to a sandbox file, creating it (and its parents) when missing.
  ///
  /// Kept separate from `writeText` because append cannot go through the
  /// temp-file-and-rename path: a rewrite would defeat the point.
  Future<Object?> _appendText(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    final text = _requiredString(params, 'text', allowEmpty: true);
    try {
      final file = File(path);
      await file.parent.create(recursive: true);
      await file.writeAsString(text, mode: FileMode.append, flush: true);
      return null;
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
  }

  /// Appends a timestamped line to `logs/mio.log` and rotates it at ~1 MB.
  ///
  /// On Android there is no console to read, so the file is the only useful
  /// sink. It lives inside the sandbox so the page can read it back with `fs`.
  Future<Object?> _log(Map<String, dynamic> params) async {
    final level = (_optionalString(params, 'level') ?? 'info').toLowerCase();
    if (!const {'debug', 'info', 'warn', 'error'}.contains(level)) {
      throw MioApiException('BAD_REQUEST', 'level must be debug/info/warn/error');
    }
    final message = _requiredString(params, 'message', allowEmpty: true);
    final stamp = DateTime.now().toUtc().toIso8601String();
    final line = '$stamp $level ${message.replaceAll('\n', r'\n')}\n';
    final file = File(p.join(_fsRoot.path, 'logs', 'mio.log'));
    try {
      await file.parent.create(recursive: true);
      await file.writeAsString(line, mode: FileMode.append, flush: true);
      if (await file.length() > 1000000) {
        final backup = File('${file.path}.1');
        if (await backup.exists()) await backup.delete();
        await file.rename(backup.path);
      }
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
    return {'path': 'logs/mio.log'};
  }



  Future<Object?> _list(Map<String, dynamic> params) async {
    final path = _resolvePath(_optionalString(params, 'path') ?? '.');
    final dir = Directory(path);
    if (!await dir.exists()) {
      throw MioApiException('FS_NOT_FOUND', 'Directory not found', {'path': path});
    }
    final entries = <Map<String, Object?>>[];
    await for (final entity in dir.list(followLinks: false)) {
      final stat = await entity.stat();
      entries.add({
        'name': p.basename(entity.path),
        'path': p.relative(entity.path, from: _fsRoot.path).replaceAll('\\', '/'),
        'type': _entityTypeName(stat.type),
        'size': stat.size,
        'modified': stat.modified.toUtc().toIso8601String(),
      });
    }
    entries.sort((a, b) => (a['name'] as String).compareTo(b['name'] as String));
    return entries;
  }

  Future<Object?> _stat(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    final type = await FileSystemEntity.type(path, followLinks: false);
    if (type == FileSystemEntityType.notFound) return null;
    final stat = await FileStat.stat(path);
    return {
      'type': _entityTypeName(type),
      'size': stat.size,
      'modified': stat.modified.toUtc().toIso8601String(),
    };
  }

  Future<Object?> _mkdir(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    try {
      await Directory(path).create(recursive: true);
      return null;
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
  }

  Future<Object?> _remove(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    if (path == _fsRoot.path) {
      throw MioApiException('FS_FORBIDDEN', 'Cannot remove the app data root');
    }
    final type = await FileSystemEntity.type(path, followLinks: false);
    if (type == FileSystemEntityType.notFound) return false;
    if (type == FileSystemEntityType.directory) {
      await Directory(path).delete(recursive: params['recursive'] == true);
    } else {
      await File(path).delete();
    }
    return true;
  }

  Future<Object?> _rename(Map<String, dynamic> params) async {
    final from = _resolvePath(_requiredString(params, 'from'));
    final to = _resolvePath(_requiredString(params, 'to'));
    try {
      await File(from).rename(to);
      return null;
    } on FileSystemException catch (error) {
      throw MioApiException('FS_ERROR', error.message, {'path': error.path});
    }
  }

  Future<Object?> _exists(Map<String, dynamic> params) async {
    final path = _resolvePath(_requiredString(params, 'path'));
    return await FileSystemEntity.type(path, followLinks: false) !=
        FileSystemEntityType.notFound;
  }

  String _entityTypeName(FileSystemEntityType type) {
    return type.toString().split('.').last;
  }

  Future<Object?> _openExternal(Map<String, dynamic> params) async {
    final raw = _requiredString(params, 'url');
    final uri = Uri.tryParse(raw);
    if (uri == null || !const {'http', 'https', 'mailto'}.contains(uri.scheme)) {
      throw MioApiException('BAD_REQUEST', 'Unsupported URL scheme');
    }
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched) {
      throw MioApiException('SHELL_ERROR', 'Could not open URL');
    }
    return null;
  }

  /// Opens a file from the app sandbox with the system default application.
  ///
  /// Windows only: Android would need a `content://` provider plus a chooser,
  /// which Mio does not ship, so pretending it works there would be a lie.
  Future<Object?> _openPath(Map<String, dynamic> params) async {
    if (platformName != 'windows') {
      throw MioApiException(
        'UNSUPPORTED',
        'shell.openPath is only available on Windows (running on $platformName)',
      );
    }
    final path = _resolvePath(_requiredString(params, 'path'));
    final type = await FileSystemEntity.type(path);
    if (type == FileSystemEntityType.notFound) {
      throw MioApiException('FS_NOT_FOUND', 'File not found', {'path': path});
    }
    final launched = await launchUrl(
      Uri.file(path),
      mode: LaunchMode.externalApplication,
    );
    if (!launched) {
      throw MioApiException('SHELL_ERROR', 'Could not open path', {'path': path});
    }
    return null;
  }

  /// Shows a sandbox file or folder in the system file manager, with the item
  /// selected when possible.
  Future<Object?> _reveal(Map<String, dynamic> params) async {
    if (platformName != 'windows') {
      throw MioApiException(
        'UNSUPPORTED',
        'shell.reveal is only available on Windows (running on $platformName)',
      );
    }
    final path = _resolvePath(_requiredString(params, 'path'));
    final type = await FileSystemEntity.type(path);
    if (type == FileSystemEntityType.notFound) {
      throw MioApiException('FS_NOT_FOUND', 'Path not found', {'path': path});
    }
    try {
      if (type == FileSystemEntityType.directory) {
        await Process.start('explorer.exe', <String>[path], mode: ProcessStartMode.detached);
      } else {
        await Process.start(
          'explorer.exe',
          <String>['/select,', path],
          mode: ProcessStartMode.detached,
        );
      }
    } on ProcessException catch (error) {
      throw MioApiException('SHELL_ERROR', error.message);
    }
    return null;
  }

  String _requiredString(
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

  String? _optionalString(Map<String, dynamic> params, String key) {
    final value = params[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  int _requiredInt(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    throw MioApiException('BAD_REQUEST', 'Missing integer parameter: $key');
  }

  List<String>? _optionalStringList(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is! List) return null;
    return value.whereType<String>().toList(growable: false);
  }
}
