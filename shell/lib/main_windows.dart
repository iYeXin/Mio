// ignore_for_file: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:webview_flutter_windows/webview_flutter_windows.dart';
import 'package:window_manager/legacy.dart';

import 'src/api.dart';
import 'src/error_app.dart';
import 'src/platform_windows.dart';
import 'src/runtime.dart';
import 'src/window_close_handler.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  try {
    final runtime = await MioRuntime.start(MioPlatformWindows());
    await windowManager.setTitle(runtime.manifest.name);
    await windowManager.setSize(
      Size(runtime.manifest.width.toDouble(), runtime.manifest.height.toDouble()),
    );
    await windowManager.center();

    // Closing must run shutdown (sidecar cleanup) before the window goes away.
    await windowManager.setPreventClose(true);
    windowManager.addListener(WindowCloseHandler(runtime.dispose));

    runApp(MioWindowsApp(runtime));
    await windowManager.waitUntilReadyToShow(
      WindowOptions(
        size: Size(
          runtime.manifest.width.toDouble(),
          runtime.manifest.height.toDouble(),
        ),
        title: runtime.manifest.name,
        center: true,
        backgroundColor: Colors.transparent,
        skipTaskbar: false,
      ),
      () async {
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
      await _controller.setDefaultContextMenusEnabled(false);
      await _controller.loadUrl(widget.runtime.webUrl);
      if (mounted) setState(() => _initialized = true);
    } catch (error) {
      if (mounted) setState(() => _error = error);
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
