import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

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
      home: _WebViewPage(runtime),
    );
  }
}

class _WebViewPage extends StatefulWidget {
  const _WebViewPage(this.runtime);

  final MioRuntime runtime;

  @override
  State<_WebViewPage> createState() => _WebViewPageState();
}

class _WebViewPageState extends State<_WebViewPage> {
  late final WebViewController _controller;
  var _loading = true;

  @override
  void initState() {
    super.initState();
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
