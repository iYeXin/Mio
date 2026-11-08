import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:convert';
import 'dart:ui' show PlatformDispatcher;

import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'src/api.dart';
import 'src/error_app.dart';
import 'src/platform_android.dart';
import 'src/runtime.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final runtime = await MioRuntime.start(MioPlatformAndroid());
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
      home: Scaffold(
        resizeToAvoidBottomInset: false,
        body: ValueListenableBuilder<Color?>(
          valueListenable: mioSystemBarColor,
          builder: (context, color, child) => ColoredBox(
            color: color ?? const Color(0xFFFFFFFF),
            child: SafeArea(top: true, bottom: true, child: child!),
          ),
          child: _WebViewPage(runtime),
        ),
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
  late final WebViewController _controller;
  var _loading = true;

  @override
  void initState() {
    super.initState();
    // Chrome remote debugging (chrome://inspect) mirrors the devtools setting.
    AndroidWebViewController.enableDebugging(widget.runtime.api.devTools);
    WidgetsBinding.instance.addObserver(this);
    _channel.setMethodCallHandler(_onNativeCall);
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xffffffff))
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) {
            if (mounted) setState(() => _loading = true);
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
            _logDisplay();
          },
          onWebResourceError: (error) {
            debugPrint('Mio WebView error: ${error.description}');
          },
          onNavigationRequest: _onNavigationRequest,
        ),
      );
    _controller.loadRequest(Uri.parse(widget.runtime.webUrl));
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
  DateTime? _lastBack;
  var _exitArmed = false;

  @override
  Future<bool> didPopRoute() async {
    try {
      return await _handleBack();
    } catch (_) {
      return false;
    }
  }

  Future<bool> _handleBack() async {
    final canGoBack = await _controller.canGoBack();
    if (await widget.runtime.api.requestBack(canGoBack: canGoBack)) return true;

    // Walking history is only useful while the page is somewhere other than
    // its entry URL; same-URL pushState entries belong to the page.
    final current = await _controller.currentUrl();
    final entry = widget.runtime.webUrl;
    if (canGoBack && current != null && !_sameEntry(current, entry)) {
      await _controller.goBack();
      return true;
    }

    // At the root: require a second press instead of exiting on the first.
    final now = DateTime.now();
    if (_exitArmed && _lastBack != null && now.difference(_lastBack!) < const Duration(seconds: 2)) {
      return false;
    }
    _exitArmed = true;
    _lastBack = now;
    _showExitHint();
    return true;
  }

  bool _sameEntry(String current, String entry) {
    String normalize(String value) {
      final uri = Uri.tryParse(value);
      if (uri == null) return value;
      return uri.replace(fragment: '').toString();
    }
    return normalize(current) == normalize(entry);
  }

  void _showExitHint() {
    final zh = PlatformDispatcher.instance.locale.languageCode == 'zh';
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(zh ? '再按一次退出' : 'Press back again to exit'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
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
    // The shell owns the window chrome: keep the page out from under the
    // status and navigation bars instead of letting each app deal with it.
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            WebViewWidget(controller: _controller),
            if (_loading)
              const ColoredBox(
                color: Color(0xffffffff),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }
}
