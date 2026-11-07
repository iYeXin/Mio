import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/api.dart';
import 'package:mio_shell/src/app_manifest.dart';
import 'package:mio_shell/src/window_actions.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory dataDir;
  MioApi? active;

  MioApi createApi({String platformName = 'windows'}) {
    return active = MioApi(
      manifest: AppManifest.fallback,
      dataDir: dataDir,
      platformName: platformName,
      windowActions: const UnsupportedWindowActions(),
    );
  }

  setUp(() async {
    dataDir = await Directory.systemTemp.createTemp('mio-fs');
  });

  tearDown(() async {
    await active?.shutdown();
    active = null;
    try {
      await dataDir.delete(recursive: true);
    } on FileSystemException {
      // Ignore leftovers.
    }
  });

  test('fs.copy duplicates a file inside the sandbox', () async {
    final api = createApi();
    await api.call('fs.writeText', {'path': 'notes/a.txt', 'text': 'hello'});
    await api.call('fs.copy', {'from': 'notes/a.txt', 'to': 'backup/a.txt'});

    final text = await api.call('fs.readText', {'path': 'backup/a.txt'});
    expect(text, 'hello');
  });

  test('fs.copy duplicates a directory recursively', () async {
    final api = createApi();
    await api.call('fs.writeText', {'path': 'tree/a.txt', 'text': 'a'});
    await api.call('fs.writeText', {'path': 'tree/inner/b.txt', 'text': 'b'});
    await api.call('fs.copy', {'from': 'tree', 'to': 'clone'});

    expect(await api.call('fs.readText', {'path': 'clone/a.txt'}), 'a');
    expect(await api.call('fs.readText', {'path': 'clone/inner/b.txt'}), 'b');
  });

  test('fs.copy reports a missing source', () async {
    final api = createApi();
    await expectLater(
      api.call('fs.copy', {'from': 'missing.txt', 'to': 'x.txt'}),
      throwsA(isA<MioApiException>().having((e) => e.code, 'code', 'FS_NOT_FOUND')),
    );
  });

  test('fs.copy refuses to copy a directory into itself', () async {
    final api = createApi();
    await api.call('fs.mkdir', {'path': 'folder'});
    await expectLater(
      api.call('fs.copy', {'from': 'folder', 'to': 'folder/inner'}),
      throwsA(isA<MioApiException>().having((e) => e.code, 'code', 'BAD_REQUEST')),
    );
  });

  test('platform.orientation validates the mode', () async {
    final api = createApi(platformName: 'android');
    await expectLater(
      api.call('platform.orientation', {'mode': 'sideways'}),
      throwsA(isA<MioApiException>().having((e) => e.code, 'code', 'BAD_REQUEST')),
    );
  });

  test('platform.orientation is unsupported on Windows', () async {
    final api = createApi();
    await expectLater(
      api.call('platform.orientation', {'mode': 'portrait'}),
      throwsA(isA<MioApiException>().having((e) => e.code, 'code', 'UNSUPPORTED')),
    );
  });

  test('platform.keepAwake toggles without throwing on Windows', () async {
    if (!Platform.isWindows) return;
    final api = createApi();
    await api.call('platform.keepAwake', {'enabled': true});
    await api.call('platform.keepAwake', {'enabled': false});
  });
}
