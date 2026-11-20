import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'api.dart';
import 'api_version.dart';
import 'app_manifest.dart';
import 'asar.dart';
import 'server.dart';
import 'window_actions.dart';

abstract class MioPlatform {
  String get name;
  Future<String?> getDevUrl();
  Future<AppManifest?> getDevManifest();
  Future<String> prepareAsar();
  WindowActions createWindowActions();
  Future<void> prepareWindow(AppManifest manifest);
}

class MioRuntime {
  MioRuntime._({
    required this.platform,
    required this.manifest,
    required this.dataDir,
    required this.server,
    required this.api,
    required this.asar,
    required this.devUrl,
    required this.splashLight,
    required this.splashDark,
  });

  final MioPlatform platform;
  final AppManifest manifest;
  final Directory dataDir;
  final MioServer server;
  final MioApi api;
  final AsarArchive? asar;
  final String? devUrl;

  /// Splash images, already decoded for the widget; null when not configured.
  ///
  /// Both brightnesses live in the archive so the widget can follow a theme
  /// change without touching the filesystem again.
  final Uint8List? splashLight;
  final Uint8List? splashDark;

  String get webUrl => devUrl == null ? server.url : server.devUrlWithBoot();

  /// Loads the app archive and manifest, but does not bind the local server yet.
  ///
  /// The UI can start with the splash screen immediately; [serve] finishes the
  /// startup (server + window) and may retry when the previous instance is
  /// still holding the origin port.
  static Future<MioRuntime> prepare(MioPlatform platform) async {
    final support = await getApplicationSupportDirectory();
    final dataDir = Directory(p.join(support.path, 'mio'));
    await dataDir.create(recursive: true);

    final devUrl = await platform.getDevUrl();
    AsarArchive? asar;
    var manifest = AppManifest.fallback;

    if (devUrl == null) {
      final asarPath = await platform.prepareAsar();
      asar = await AsarArchive.open(asarPath);
      final manifestJson = await asar.readJson('mio-manifest.json');
      if (manifestJson != null) {
        manifest = AppManifest.fromJson(manifestJson);
      }
    } else {
      manifest = await platform.getDevManifest() ?? AppManifest.fallback;
    }

    // Fail fast when the app was built against an API this shell does not
    // implement, instead of surfacing confusing bridge errors later.
    final compatibility = checkApiCompatibility(
      runtime: mioApiVersion,
      required: manifest.requiredApiVersion,
    );
    if (compatibility != null) {
      throw StateError(compatibility);
    }

    Uint8List? splashLight;
    Uint8List? splashDark;
    if (devUrl == null && asar != null) {
      final lightPath = manifest.splashPath(dark: false);
      final darkPath = manifest.splashPath(dark: true);
      splashLight = await _readSplash(asar, lightPath);
      splashDark = darkPath == lightPath
          ? splashLight
          : await _readSplash(asar, darkPath);
    }

    final api = MioApi(
      manifest: manifest,
      dataDir: dataDir,
      platformName: platform.name,
      windowActions: platform.createWindowActions(),
      asar: asar,
    );
    final server = MioServer(
      manifest: manifest,
      api: api,
      asar: asar,
      devUrl: devUrl,
    );

    return MioRuntime._(
      platform: platform,
      manifest: manifest,
      dataDir: dataDir,
      server: server,
      api: api,
      asar: asar,
      devUrl: devUrl,
      splashLight: splashLight,
      splashDark: splashDark,
    );
  }

  /// A missing or unreadable splash must never block startup.
  static Future<Uint8List?> _readSplash(AsarArchive asar, String? path) async {
    if (path == null) return null;
    try {
      return await asar.read(path);
    } catch (_) {
      return null;
    }
  }

  bool _served = false;
  Future<void>? _serving;

  /// Binds the local origin and prepares the window. Idempotent and safe to
  /// call from the UI after the splash is already on screen.
  Future<void> serve() {
    if (_served) return Future<void>.value();
    return _serving ??= _serve();
  }

  Future<void> _serve() async {
    await server.start();
    await platform.prepareWindow(manifest);
    _served = true;
  }

  /// Prepare + serve in one call, kept for callers that do not need a splash.
  static Future<MioRuntime> start(MioPlatform platform) async {
    final runtime = await prepare(platform);
    await runtime.serve();
    return runtime;
  }

  Future<void> dispose() async {
    // Stop children first: their exit events are meaningless once the bridge is
    // gone, and a half-closed server would swallow the errors.
    await api.shutdown();
    await server.stop();
  }
}
