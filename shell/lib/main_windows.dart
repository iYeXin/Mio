// ignore_for_file: deprecated_member_use
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:webview_flutter_windows/webview_flutter_windows.dart';
import 'package:window_manager/legacy.dart';

import 'src/api.dart';
import 'src/app_manifest.dart';
import 'src/error_app.dart';
import 'src/platform_windows.dart';
import 'src/runtime.dart';
import 'src/window_close_handler.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  try {
    final runtime = await MioRuntime.start(MioPlatformWindows());
    final manifest = runtime.manifest;

    // Closing must run shutdown (sidecar cleanup) before the window goes away.
    await windowManager.setPreventClose(true);
    windowManager.addListener(WindowCloseHandler(runtime.dispose));
    windowManager.addListener(_WindowStateReporter(runtime.api));

    runApp(MioWindowsApp(runtime));
    await windowManager.waitUntilReadyToShow(
      WindowOptions(
        size: Size(manifest.width.toDouble(), manifest.height.toDouble()),
        minimumSize: _minimumSize(manifest),
        title: manifest.title,
        center: manifest.center,
        alwaysOnTop: manifest.alwaysOnTop,
        backgroundColor: Colors.transparent,
        skipTaskbar: false,
      ),
      () async {
        // Everything the config can express is applied before the first frame,
        // so the window never jumps or re-decorates in front of the user.
        if (!manifest.decorations) await windowManager.setAsFrameless();
        if (!manifest.resizable) await windowManager.setResizable(false);
        if (manifest.x != null && manifest.y != null) {
          await windowManager.setPosition(
            Offset(manifest.x!.toDouble(), manifest.y!.toDouble()),
          );
        }
        await windowManager.show();
        await windowManager.focus();
      },
    );
  } catch (error, stack) {
    runApp(MioFatalErrorApp(error: error, stack: stack));
    await windowManager.waitUntilReadyToShow(
      const WindowOptions(size: Size(900, 600), center: true, title: 'Mio'),
      () async {
        await windowManager.show();
        await windowManager.focus();
      },
    );
  }
}

Size? _minimumSize(AppManifest manifest) {
  final width = manifest.minWidth;
  final height = manifest.minHeight;
  if (width == null && height == null) return null;
  return Size((width ?? 320).toDouble(), (height ?? 240).toDouble());
}

/// Pushes `window.state` to the page after a move or resize so a custom title
/// bar can keep its layout in sync.
class _WindowStateReporter with WindowListener {
  _WindowStateReporter(this.api);

  final MioApi api;
  Timer? _debounce;

  @override
  void onWindowResize() => _schedule();

  @override
  void onWindowMove() => _schedule();

  @override
  void onWindowMaximize() => _schedule();

  @override
  void onWindowUnmaximize() => _schedule();

  void _schedule() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 120), () async {
      try {
        api.emit('window.state', await api.call('window.state', const {}));
      } catch (_) {
        // Best-effort: the window may already be closing.
      }
    });
  }
}

class MioWindowsApp extends StatelessWidget {
  const MioWindowsApp(this.runtime, {super.key});

  final MioRuntime runtime;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: runtime.manifest.name,
      navigatorKey: mioNavigatorKey,
      debugShowCheckedModeBanner: false,
      home: _WindowsWebViewPage(runtime),
    );
  }
}

class _WindowsWebViewPage extends StatefulWidget {
  const _WindowsWebViewPage(this.runtime);

  final MioRuntime runtime;

  @override
  State<_WindowsWebViewPage> createState() => _WindowsWebViewPageState();
}

class _WindowsWebViewPageState extends State<_WindowsWebViewPage> {
  final _controller = WebviewController();
  var _initialized = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      await WebviewController.initializeEnvironment(
        userDataPath: p.join(widget.runtime.dataDir.path, 'webview2'),
      );
      await _controller.initialize();
      // Right-click and text-selection menus are part of the platform; the
      // "Inspect" entry only appears when devtools are enabled.
      await _controller.setDefaultContextMenusEnabled(true);
      await _controller.setDevToolsEnabled(widget.runtime.api.devTools);
      await _controller.loadUrl(widget.runtime.webUrl);
      unawaited(_logDisplay());
      if (mounted) setState(() => _initialized = true);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  /// One startup log line with geometry, so HiDPI or sizing problems can be
  /// diagnosed from `logs/mio.log` alone.
  Future<void> _logDisplay() async {
    try {
      final display = await widget.runtime.api.call('platform.display', const {});
      await widget.runtime.api.call('app.log', {
        'level': 'info',
        'message': 'display ${jsonEncode(display)}',
      });
    } catch (_) {
      // Diagnostics must never block startup.
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 48),
                const SizedBox(height: 16),
                const Text('WebView2 runtime is unavailable or failed to start'),
                const SizedBox(height: 8),
                SelectableText('$_error'),
              ],
            ),
          ),
        ),
      );
    }
    if (!_initialized) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(body: Webview(_controller));
  }
}
