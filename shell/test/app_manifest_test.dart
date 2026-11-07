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
  });
}
