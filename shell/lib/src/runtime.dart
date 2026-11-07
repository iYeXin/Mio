import 'dart:io';

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
  });

  final MioPlatform platform;
  final AppManifest manifest;
  final Directory dataDir;
  final MioServer server;
  final MioApi api;
  final AsarArchive? asar;
  final String? devUrl;

  String get webUrl => devUrl == null ? server.url : server.devUrlWithBoot();

  static Future<MioRuntime> start(MioPlatform platform) async {
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
    await server.start();
    await platform.prepareWindow(manifest);

    return MioRuntime._(
      platform: platform,
      manifest: manifest,
      dataDir: dataDir,
      server: server,
      api: api,
      asar: asar,
      devUrl: devUrl,
    );
  }

  Future<void> dispose() async {
    // Stop children first: their exit events are meaningless once the bridge is
    // gone, and a half-closed server would swallow the errors.
    await api.shutdown();
    await server.stop();
  }
}
