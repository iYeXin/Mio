import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/app_manifest.dart';

void main() {
  test('parses app manifest', () {
    final manifest = AppManifest.fromJson({
      'id': 'com.example.demo',
      'name': 'Demo',
      'version': '1.2.3',
      'entry': '/index.html',
      'window': {'width': 900, 'height': 600},
    });
    expect(manifest.id, 'com.example.demo');
    expect(manifest.entry, 'index.html');
    expect(manifest.width, 900);
  });

  test('falls back for invalid fields', () {
    final manifest = AppManifest.fromJson({'name': ''});
    expect(manifest.name, AppManifest.fallback.name);
    expect(manifest.width, 1024);
    expect(manifest.theme, 'system');
    expect(manifest.statusBar, 'visible');
    expect(manifest.orientation, 'auto');
  });

  test('parses per-theme splash and Android startup chrome', () {
    final manifest = AppManifest.fromJson({
      'id': 'com.example.demo',
      'name': 'Demo',
      'version': '1.0.0',
      'entry': 'index.html',
      'window': {
        'theme': 'dark',
        'splash': {'dark': '__mio__/splash-dark.png'},
        'splashBackground': {'light': '#ffffff', 'dark': '#000000'},
        'splashFit': 'cover',
      },
      'android': {'statusBar': 'immersive', 'orientation': 'portrait'},
    });
    expect(manifest.theme, 'dark');
    expect(manifest.splashPath(dark: true), '__mio__/splash-dark.png');
    // One variant covers the other brightness.
    expect(manifest.splashPath(dark: false), '__mio__/splash-dark.png');
    expect(manifest.splashBackgroundFor(dark: true), '#000000');
    expect(manifest.splashBackgroundFor(dark: false), '#ffffff');
    expect(manifest.splashFit, 'cover');
    expect(manifest.statusBar, 'immersive');
    expect(manifest.orientation, 'portrait');
  });

  test('accepts the single-image splash and rejects unknown modes', () {
    final single = AppManifest.fromJson({
      'id': 'com.example.demo',
      'name': 'Demo',
      'version': '1.0.0',
      'entry': 'index.html',
      'window': {'splash': '__mio__/splash.png'},
      'android': {'statusBar': 'sideways', 'orientation': 'upside-down'},
    });
    expect(single.splashPath(dark: true), '__mio__/splash.png');
    expect(single.splashPath(dark: false), '__mio__/splash.png');
    expect(single.statusBar, 'visible');
    expect(single.orientation, 'auto');
    expect(single.splashBackgroundFor(dark: true), isNull);
  });
}
