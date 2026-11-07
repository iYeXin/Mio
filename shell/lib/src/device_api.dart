import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import 'app_manifest.dart';
import 'errors.dart';

/// Platform-specific device capabilities.
///
/// These are deliberately not normalised: Android has notifications and a photo
/// picker backed by the gallery, Windows has neither. `app.info().features`
/// reports what is available, and calling an unsupported method returns
/// `UNSUPPORTED`.
class MioDeviceApi {
  MioDeviceApi({
    required this.platformName,
    required this.manifest,
    required this.dataDir,
  });

  static const MethodChannel _channel = MethodChannel('mio/runtime');

  final String platformName;
  final AppManifest manifest;
  final Directory dataDir;

  Directory get mediaDir => Directory(p.join(dataDir.path, 'app', 'media'));

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'notify.send':
        return await _send(params);
      case 'media.pickImage':
        return await _pickImage();
      case 'foreground.start':
        return await _foregroundStart(params);
      case 'foreground.stop':
        return await _foregroundStop();
      case 'foreground.info':
        return <String, Object?>{
          'supported': platformName == 'android',
          'declared': manifest.foregroundService,
        };
      default:
        throw MioApiException(
          'METHOD_NOT_FOUND',
          'Unknown Mio device method: $method',
        );
    }
  }

  Future<Object?> _send(Map<String, dynamic> params) async {
    if (platformName != 'android') {
      throw MioApiException(
        'UNSUPPORTED',
        'notify.send is only available on Android',
      );
    }
    final title = _string(params, 'title') ?? 'Mio';
    final body = _string(params, 'body') ?? '';
    final id = params['id'];
    try {
      await _channel.invokeMethod<void>('notify.send', {
        'title': title,
        'body': body,
        'id': id is int ? id : null,
      });
      return <String, Object?>{'id': id is int ? id : 4001};
    } on PlatformException catch (error) {
      throw MioApiException(
        'NOTIFY_FAILED',
        error.message ?? 'Could not post the notification',
        {'code': error.code},
      );
    }
  }

  Future<Object?> _pickImage() async {
    final directory = mediaDir;
    await directory.create(recursive: true);

    if (platformName == 'android') {
      try {
        final result = await _channel.invokeMapMethod<String, Object?>(
          'media.pickImage',
          {'destination': directory.path},
        );
        if (result == null) return null;
        return <String, Object?>{
          'path': p.relative(
            result['path']! as String,
            from: p.join(dataDir.path, 'app'),
          ).replaceAll('\\', '/'),
          'name': result['name'],
          'mime': result['mime'],
          'size': result['size'],
        };
      } on PlatformException catch (error) {
        throw MioApiException(
          'MEDIA_FAILED',
          error.message ?? 'Could not pick an image',
          {'code': error.code},
        );
      }
    }

    if (platformName == 'windows') {
      const group = XTypeGroup(
        label: 'Images',
        extensions: <String>['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
      );
      final file = await openFile(acceptedTypeGroups: <XTypeGroup>[group]);
      if (file == null) return null;
      final target = File(p.join(directory.path, p.basename(file.path)));
      await File(file.path).copy(target.path);
      return <String, Object?>{
        'path': p
            .relative(target.path, from: p.join(dataDir.path, 'app'))
            .replaceAll('\\', '/'),
        'name': p.basename(target.path),
        'mime': _mimeOf(target.path),
        'size': await target.length(),
      };
    }

    throw MioApiException(
      'UNSUPPORTED',
      'media.pickImage is not available on $platformName',
    );
  }

  Future<Object?> _foregroundStart(Map<String, dynamic> params) async {
    if (!manifest.foregroundService) {
      throw MioApiException(
        'FORBIDDEN',
        'The app did not declare android.foregroundService in mio.config.json',
      );
    }
    if (platformName != 'android') {
      throw MioApiException(
        'UNSUPPORTED',
        'foreground.start is only available on Android',
      );
    }
    try {
      final result = await _channel.invokeMapMethod<String, Object?>(
        'foreground.start',
        {
          'title': _string(params, 'title') ?? manifest.name,
          'text': _string(params, 'text') ?? 'Running in the background',
        },
      );
      return <String, Object?>{'running': result?['running'] == true};
    } on PlatformException catch (error) {
      throw MioApiException(
        'FOREGROUND_FAILED',
        error.message ?? 'Could not start the foreground service',
        {'code': error.code},
      );
    }
  }

  Future<Object?> _foregroundStop() async {
    if (platformName != 'android') {
      throw MioApiException(
        'UNSUPPORTED',
        'foreground.stop is only available on Android',
      );
    }
    try {
      await _channel.invokeMethod<Object?>('foreground.stop');
      return <String, Object?>{'running': false};
    } on PlatformException catch (error) {
      throw MioApiException(
        'FOREGROUND_FAILED',
        error.message ?? 'Could not stop the foreground service',
        {'code': error.code},
      );
    }
  }

  String? _string(Map<String, dynamic> params, String key) {
    final value = params[key];
    return value is String && value.isNotEmpty ? value : null;
  }

  String _mimeOf(String path) {
    final extension = p.extension(path).toLowerCase();
    switch (extension) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      case '.bmp':
        return 'image/bmp';
      default:
        return 'application/octet-stream';
    }
  }
}
