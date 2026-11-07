// ignore_for_file: deprecated_member_use
import 'dart:ffi' hide Size;
import 'dart:ui';

import 'package:ffi/ffi.dart';
import 'package:window_manager/legacy.dart';

import 'window_actions.dart';

/// Window control for Windows, backed by window_manager's 0.5-compatible API.
class WindowActionsWindows implements WindowActions {
  WindowManager get _manager => WindowManager.instance;

  static final DynamicLibrary _user32 = DynamicLibrary.open('user32.dll');

  static final int Function(Pointer<Utf16>, Pointer<Utf16>) _findWindow = _user32
      .lookupFunction<IntPtr Function(Pointer<Utf16>, Pointer<Utf16>), int Function(Pointer<Utf16>, Pointer<Utf16>)>(
    'FindWindowW',
  );

  static final int Function(int) _getMenu = _user32
      .lookupFunction<IntPtr Function(IntPtr), int Function(int)>('GetMenu');
  static final int Function(int, int) _setMenu = _user32
      .lookupFunction<Int32 Function(IntPtr, IntPtr), int Function(int, int)>('SetMenu');
  static final int Function(int) _drawMenuBar = _user32
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>('DrawMenuBar');

  /// Flutter's Windows runner registers this window class.
  static const String _windowClass = 'FLUTTER_RUNNER_WIN32_WINDOW';

  int? _window;
  int? _savedMenu;

  int _hwnd() {
    final cached = _window;
    if (cached != null) return cached;
    final className = _windowClass.toNativeUtf16();
    try {
      final handle = _findWindow(nullptr, className);
      _window = handle;
      return handle;
    } finally {
      calloc.free(className);
    }
  }

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
  Future<void> setDecorations(bool decorations) async {
    if (!decorations) await _manager.setAsFrameless();
  }

  @override
  Future<void> startDragging() => _manager.startDragging();

  @override
  Future<void> setResizable(bool resizable) => _manager.setResizable(resizable);

  @override
  Future<void> setMinimumSize(int width, int height) =>
      _manager.setMinimumSize(Size(width.toDouble(), height.toDouble()));

  @override
  Future<void> setVisible(bool visible) async {
    if (visible) {
      await _manager.show();
    } else {
      await _manager.hide();
    }
  }

  @override
  Future<void> setHasShadow(bool hasShadow) => _manager.setHasShadow(hasShadow);

  @override
  Future<void> focus() => _manager.focus();

  @override
  Future<void> blur() => _manager.blur();

  /// Hides or restores the native menu bar.
  ///
  /// Mio's templates do not install a menu, so this is only meaningful for a
  /// window that already has one; the call reports what actually happened.
  @override
  Future<Map<String, Object?>> setMenuBarVisible(bool visible) async {
    final hwnd = _hwnd();
    if (hwnd == 0) {
      throw const WindowActionException('Cannot find the application window');
    }
    if (!visible) {
      final menu = _getMenu(hwnd);
      if (menu != 0) {
        _savedMenu = menu;
        _setMenu(hwnd, 0);
        _drawMenuBar(hwnd);
      }
    } else if (_savedMenu != null) {
      _setMenu(hwnd, _savedMenu!);
      _drawMenuBar(hwnd);
      _savedMenu = null;
    }
    return <String, Object?>{
      'hasMenu': _getMenu(hwnd) != 0,
      'visible': _getMenu(hwnd) != 0,
    };
  }

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
      'isVisible': await _manager.isVisible(),
      'isFocused': await _manager.isFocused(),
      'hasShadow': await _manager.hasShadow(),
    };
  }
}
