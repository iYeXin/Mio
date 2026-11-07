abstract class WindowActions {
  bool get supported;

  Future<void> setTitle(String title);
  Future<void> minimize();
  Future<void> maximize();
  Future<void> restore();
  Future<void> close();
  Future<void> center();
  Future<void> moveTo(int x, int y);
  Future<void> setSize(int width, int height);
  Future<void> setFullScreen(bool fullScreen);
  Future<void> setAlwaysOnTop(bool alwaysOnTop);

  /// Hides the title bar and frame; the page draws its own and calls
  /// [startDragging] from a pointer-down handler.
  Future<void> setDecorations(bool decorations);

  /// Starts a native window drag; call from a title-bar pointer-down.
  Future<void> startDragging();

  Future<void> setResizable(bool resizable);

  Future<void> setMinimumSize(int width, int height);
  Future<Map<String, Object?>> getState();
}

class UnsupportedWindowActions implements WindowActions {
  const UnsupportedWindowActions();

  @override
  bool get supported => false;

  Never _unsupported() {
    throw const WindowActionException('window APIs are not supported on this platform');
  }

  @override
  Future<void> setTitle(String title) async => _unsupported();

  @override
  Future<void> minimize() async => _unsupported();

  @override
  Future<void> maximize() async => _unsupported();

  @override
  Future<void> restore() async => _unsupported();

  @override
  Future<void> close() async => _unsupported();

  @override
  Future<void> center() async => _unsupported();

  @override
  Future<void> moveTo(int x, int y) async => _unsupported();

  @override
  Future<void> setSize(int width, int height) async => _unsupported();

  @override
  Future<void> setFullScreen(bool fullScreen) async => _unsupported();

  @override
  Future<void> setAlwaysOnTop(bool alwaysOnTop) async => _unsupported();

  @override
  Future<void> setDecorations(bool decorations) async => _unsupported();

  @override
  Future<void> startDragging() async => _unsupported();

  @override
  Future<void> setResizable(bool resizable) async => _unsupported();

  @override
  Future<void> setMinimumSize(int width, int height) async => _unsupported();

  @override
  Future<Map<String, Object?>> getState() async => {
        'supported': false,
      };
}

class WindowActionException implements Exception {
  const WindowActionException(this.message);
  final String message;

  @override
  String toString() => 'WindowActionException: $message';
}
