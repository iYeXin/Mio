import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'app_manifest.dart';
import 'runtime.dart';
import 'window_actions.dart';

class MioPlatformAndroid implements MioPlatform {
  static const MethodChannel _channel = MethodChannel('mio/runtime');

  @override
  String get name => 'android';

  Future<Map<Object?, Object?>> _launchConfig() async {
    try {
      return await _channel.invokeMethod<Map<Object?, Object?>>('getLaunchConfig') ??
          const <Object?, Object?>{};
    } on MissingPluginException {
      return const <Object?, Object?>{};
    } on PlatformException {
      return const <Object?, Object?>{};
    }
  }

  @override
  Future<String?> getDevUrl() async {
    final config = await _launchConfig();
    final value = config['devUrl'];
    return value is String && value.isNotEmpty ? value : null;
  }

  @override
  Future<AppManifest?> getDevManifest() async {
    final config = await _launchConfig();
    final name = config['appName'];
    if (name is! String || name.isEmpty) return null;
    final width = config['windowWidth'];
    final height = config['windowHeight'];
    return AppManifest(
      id: config['appId'] is String ? config['appId']! as String : AppManifest.fallback.id,
      name: name,
      version: config['appVersion'] is String
          ? config['appVersion']! as String
          : AppManifest.fallback.version,
      entry: 'index.html',
      width: width is int && width > 0 ? width : 1024,
      height: height is int && height > 0 ? height : 720,
    );
  }

  @override
  Future<String> prepareAsar() async {
    final support = await getApplicationSupportDirectory();
    final directory = Directory(p.join(support.path, 'mio'));
    await directory.create(recursive: true);
    final destination = p.join(directory.path, 'app.asar');

    try {
      await _channel.invokeMethod<String>('copyAsset', {
        'asset': 'mio/app.asar',
        'dest': destination,
      });
    } on PlatformException catch (error) {
      throw StateError(
        'Unable to read assets/mio/app.asar from the APK: ${error.message}',
      );
    }

    final file = File(destination);
    if (!await file.exists() || await file.length() == 0) {
      throw StateError('The injected app.asar is missing or empty');
    }
    return destination;
  }

  @override
  WindowActions createWindowActions() => const UnsupportedWindowActions();

  @override
  Future<void> prepareWindow(AppManifest manifest) async {}
}
