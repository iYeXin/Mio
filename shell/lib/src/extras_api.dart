// ignore_for_file: deprecated_member_use
import 'dart:async';
import 'dart:io';

import 'package:share_plus/share_plus.dart';
import 'package:flutter/services.dart';
import 'package:tray_manager/legacy.dart';

import 'errors.dart';

/// Windows tray icon and the system share sheet.
///
/// Tray menu items are declared by the page; clicks come back as `tray.menu`
/// events with the item id, and left/right clicks as `tray.click`.
class MioExtrasApi with TrayListener {
  MioExtrasApi({
    required this.platformName,
    required this.emit,
    required this.resolvePath,
  }) {
    if (platformName == 'windows') trayManager.addListener(this);
  }

  final String platformName;
  final void Function(String name, Object? data) emit;
  final String Function(String path) resolvePath;

  bool _trayReady = false;

  Future<Object?> call(String method, Map<String, dynamic> params) async {
    switch (method) {
      case 'tray.set':
        return await _setTray(params);
      case 'tray.remove':
        return await _removeTray();
      case 'share.text':
        return await _shareText(params);
      case 'share.file':
        return await _shareFile(params);
      default:
        throw MioApiException(
          'METHOD_NOT_FOUND',
          'Unknown Mio method: $method',
        );
    }
  }

  Future<Object?> _setTray(Map<String, dynamic> params) async {
    if (platformName != 'windows') {
      throw MioApiException('UNSUPPORTED', 'tray is Windows only');
    }
    final icon = params['icon'];
    if (icon is String && icon.isNotEmpty) {
      final path = resolvePath(icon);
      if (!await File(path).exists()) {
        throw MioApiException('TRAY_ICON_MISSING', 'Tray icon not found', {
          'path': icon,
        });
      }
      await trayManager.setIcon(path);
    }
    final tooltip = params['tooltip'];
    if (tooltip is String && tooltip.isNotEmpty) {
      await trayManager.setToolTip(tooltip);
    }
    final menu = params['menu'];
    if (menu is List) {
      final items = <MenuItem>[];
      for (final entry in menu) {
        if (entry is! Map) continue;
        if (entry['separator'] == true) {
          items.add(MenuItem.separator());
          continue;
        }
        final id = entry['id'];
        final label = entry['label'];
        if (id == null || label == null) continue;
        items.add(MenuItem(key: '$id', label: '$label'));
      }
      await trayManager.setContextMenu(Menu(items: items));
    }
    _trayReady = true;
    return <String, Object?>{'set': true};
  }

  Future<Object?> _removeTray() async {
    if (platformName != 'windows') {
      throw MioApiException('UNSUPPORTED', 'tray is Windows only');
    }
    await trayManager.destroy();
    _trayReady = false;
    return <String, Object?>{'removed': true};
  }

  Future<Object?> _shareText(Map<String, dynamic> params) async {
    final text = params['text'];
    if (text is! String || text.isEmpty) {
      throw MioApiException('BAD_REQUEST', 'Missing parameter: text');
    }
    final subject = params['subject'];
    try {
      final result = await SharePlus.instance.share(
        ShareParams(text: text, subject: subject is String ? subject : null),
      );
      return <String, Object?>{'status': result.status.name};
    } on UnimplementedError {
      throw MioApiException('UNSUPPORTED', 'Sharing is not available on $platformName');
    } on PlatformException catch (error) {
      throw MioApiException('SHARE_FAILED', error.message ?? 'Share failed', {
        'code': error.code,
      });
    }
  }

  Future<Object?> _shareFile(Map<String, dynamic> params) async {
    final path = params['path'];
    if (path is! String || path.isEmpty) {
      throw MioApiException('BAD_REQUEST', 'Missing parameter: path');
    }
    final file = File(resolvePath(path));
    if (!await file.exists()) {
      throw MioApiException('SHARE_FILE_MISSING', 'File not found', {'path': path});
    }
    final mimeType = params['mimeType'];
    try {
      final result = await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: mimeType is String ? mimeType : null)],
          subject: params['subject'] is String ? params['subject'] as String : null,
        ),
      );
      return <String, Object?>{'status': result.status.name};
    } on UnimplementedError {
      throw MioApiException('UNSUPPORTED', 'Sharing is not available on $platformName');
    } on PlatformException catch (error) {
      throw MioApiException('SHARE_FAILED', error.message ?? 'Share failed', {
        'code': error.code,
      });
    }
  }

  // ------------------------------------------------------------- tray events

  @override
  void onTrayIconMouseDown() => emit('tray.click', <String, Object?>{'button': 'left'});

  @override
  void onTrayIconRightMouseDown() =>
      emit('tray.click', <String, Object?>{'button': 'right'});

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    emit('tray.menu', <String, Object?>{'id': menuItem.key, 'label': menuItem.label});
  }

  Future<void> dispose() async {
    if (platformName == 'windows' && _trayReady) {
      trayManager.removeListener(this);
      await trayManager.destroy();
      _trayReady = false;
    }
  }
}
