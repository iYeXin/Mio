import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'src/api.dart';
import 'src/error_app.dart';
import 'src/platform_android.dart';
import 'src/runtime.dart';
import 'src/splash.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    // Phase 1 only reads the archive and manifest, so the splash screen can be
    // on screen while the server binds (and retries) and the WebView loads.
    final runtime = await MioRuntime.prepare(MioPlatformAndroid());
    runApp(MioAndroidApp(runtime));
  } catch (error, stack) {
    runApp(MioFatalErrorApp(error: error, stack: stack));
  }
}

class MioAndroidApp extends StatelessWidget {
  const MioAndroidApp(this.runtime, {super.key});

  final MioRuntime runtime;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: runtime.manifest.name,
      navigatorKey: mioNavigatorKey,
      debugShowCheckedModeBanner: false,
      // The area behind the status bar is painted by the shell so
      // `platform.setSystemBars` works on Android 15+ (edge-to-edge).
      home: ValueListenableBuilder<Color?>(
        valueListenable: mioSystemBarColor,
        builder: (context, color, child) => ColoredBox(
          color: color ??
              parseMioColor(runtime.manifest.backgroundColor, const Color(0xFFFFFFFF)),
          child: child!,
        ),
        child: _WebViewPage(runtime),
      ),
    );
  }
}

class _WebViewPage extends StatefulWidget {
  const _WebViewPage(this.runtime);

  final MioRuntime runtime;

  @override
  State<_WebViewPage> createState() => _WebViewPageState();
}

class _WebViewPageState extends State<_WebViewPage> with WidgetsBindingObserver {
  static const MethodChannel _channel = MethodChannel('mio/runtime');
  WebViewController? _controller;
  var _loading = true;

  Color get _background => parseMioColor(
        widget.runtime.manifest.backgroundColor,
        const Color(0xFFFFFFFF),
      );

  @override
  void initState() {
    super.initState();
    // Chrome remote debugging (chrome://inspect) mirrors the devtools setting.
    AndroidWebViewController.enableDebugging(widget.runtime.api.devTools);
    WidgetsBinding.instance.addObserver(this);
    _channel.setMethodCallHandler(_onNativeCall);
    unawaited(_boot());
  }

  /// Binds the local origin first; the splash stays visible while [MioRuntime.serve]
  /// retries a port the previous process may still be releasing.
  Future<void> _boot() async {
    try {
      await widget.runtime.serve();
    } catch (error, stack) {
      if (mounted) runApp(MioFatalErrorApp(error: error, stack: stack));
      return;
    }
    if (!mounted) return;

    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(_background)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) {
            if (mounted) setState(() => _loading = true);
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
            // Keep the first frame free of diagnostics I/O.
            Future<void>.delayed(const Duration(seconds: 1), _logDisplay);
          },
          onWebResourceError: (error) {
            debugPrint('Mio WebView error: ${error.description}');
          },
          onNavigationRequest: _onNavigationRequest,
        ),
      );
    setState(() => _controller = controller);
    await controller.loadRequest(Uri.parse(widget.runtime.webUrl));
  }

  NavigationDecision _onNavigationRequest(NavigationRequest request) {
    final target = Uri.tryParse(request.url);
    if (target == null) return NavigationDecision.prevent;
    final server = widget.runtime.server;
    final allowedHosts = {'127.0.0.1', 'localhost'};
    if (allowedHosts.contains(target.host) && target.port == server.port) {
      return NavigationDecision.navigate;
    }
    final devUrl = widget.runtime.devUrl;
    if (devUrl != null) {
      final dev = Uri.tryParse(devUrl);
      if (dev != null &&
          target.scheme == dev.scheme &&
          target.host == dev.host &&
          target.port == dev.port) {
        return NavigationDecision.navigate;
      }
    }

    if (target.scheme == 'http' || target.scheme == 'https' || target.scheme == 'mailto') {
      launchUrl(target, mode: LaunchMode.externalApplication);
    }
    return NavigationDecision.prevent;
  }

  Future<Object?> _onNativeCall(MethodCall call) async {
    if (call.method == 'backPressed') return await _handleBack();
    return null;
  }

  @override
  void dispose() {
    _channel.setMethodCallHandler(null);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Back first asks the page, then walks WebView history, and only exits when
  /// there is nowhere left to go.
  @override
  Future<bool> didPopRoute() async {
    try {
      return await _handleBack();
    } catch (_) {
      return false;
    }
  }

  /// Back is the app's decision: the page gets 400 ms to consume it, history
  /// is walked only when the page moved away from its entry URL, and the shell
  /// exits when neither happened. The framework adds no exit prompt of its own.
  Future<bool> _handleBack() async {
    final controller = _controller;
    if (controller == null) return false;
    final canGoBack = await controller.canGoBack();
    if (await widget.runtime.api.requestBack(canGoBack: canGoBack)) return true;

    final current = await controller.currentUrl();
    final entry = widget.runtime.webUrl;
    if (canGoBack && current != null && !_sameEntry(current, entry)) {
      await controller.goBack();
      return true;
    }
    return false;
  }

  bool _sameEntry(String current, String entry) {
    String normalize(String value) {
      final uri = Uri.tryParse(value);
      if (uri == null) return value;
      return uri.replace(fragment: '').toString();
    }

    return normalize(current) == normalize(entry);
  }

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
  Widget build(BuildContext context) {
    final controller = _controller;
    return Scaffold(
      backgroundColor: _background,
      // The page lays itself out from `platform.viewport` (adjustNothing: the
      // window never resizes for the IME). Without this, Scaffold still shrinks
      // its body by MediaQuery.viewInsets on every IME animation frame, which
      // resizes the WebView platform view each frame and is what made the page
      // stutter when the keyboard opened.
      resizeToAvoidBottomInset: false,
      // Edge-to-edge: the page owns the whole window.
      body: Stack(
        children: [
          if (controller != null) WebViewWidget(controller: controller),
          if (_loading)
            Positioned.fill(
              child: IgnorePointer(
                child: MioSplash(
                  manifest: widget.runtime.manifest,
                  image: widget.runtime.splashBytes,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
