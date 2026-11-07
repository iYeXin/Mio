// ignore_for_file: deprecated_member_use
import 'dart:ui';

import 'package:window_manager/legacy.dart';

import 'window_actions.dart';

/// Window control for Windows, backed by window_manager's 0.5-compatible API.
class WindowActionsWindows implements WindowActions {
  WindowManager get _manager => WindowManager.instance;

  @override
  bool get supported => true;

  @override
  Future<void> setTitle(String title) => _manager.setTitle(title);

  @override
  Future<void> minimize() => _manager.minimize();

  @override
  Future<void> maximize() => _manager.maximize();

  @override
  Future<void> restore() => _manager.unmaximize();

  @override
  Future<void> close() => _manager.close();

  @override
  Future<void> center() => _manager.center();

  @override
  Future<void> moveTo(int x, int y) {
    return _manager.setPosition(Offset(x.toDouble(), y.toDouble()));
  }

  @override
  Future<void> setSize(int width, int height) {
    return _manager.setSize(Size(width.toDouble(), height.toDouble()));
  }

  @override
  Future<void> setFullScreen(bool fullScreen) => _manager.setFullScreen(fullScreen);

  @override
  Future<void> setAlwaysOnTop(bool alwaysOnTop) => _manager.setAlwaysOnTop(alwaysOnTop);

  @override
  Future<Map<String, Object?>> getState() async {
    final bounds = await _manager.getBounds();
    return {
      'supported': true,
      'x': bounds.left.round(),
      'y': bounds.top.round(),
      'width': bounds.width.round(),
      'height': bounds.height.round(),
      'isMaximized': await _manager.isMaximized(),
      'isFullScreen': await _manager.isFullScreen(),
    };
  }
}
