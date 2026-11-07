// ignore_for_file: deprecated_member_use
import 'dart:async';
import 'dart:io';

import 'package:window_manager/legacy.dart';

/// Runs shutdown work when the window is about to close.
///
/// Sidecar processes are children of this app; nothing kills them when the
/// window goes away, so a plain close would orphan them. The window is
/// therefore put in prevent-close mode and closing becomes an async path:
/// stop the server, stop sidecars, then really close.
///
/// A hard crash still orphans children — Flutter gives no hook for that.
class WindowCloseHandler with WindowListener {
  WindowCloseHandler(this.onShutdown);

  final Future<void> Function() onShutdown;

  var _closing = false;

  @override
  void onWindowClose() {
    if (_closing) return;
    _closing = true;
    unawaited(_close());
  }

  Future<void> _close() async {
    try {
      await onShutdown();
    } catch (error) {
      stderr.writeln('Mio shutdown failed: $error');
    } finally {
      // destroy() bypasses prevent-close and lets the platform end the app.
      await WindowManager.instance.destroy();
    }
  }
}
