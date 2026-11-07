import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/api.dart';
import 'package:mio_shell/src/app_manifest.dart';
import 'package:mio_shell/src/window_actions.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory dataDir;
  MioApi? active;

  MioApi createApi(String platformName) {
    return active = MioApi(
      manifest: AppManifest.fallback,
      dataDir: dataDir,
      platformName: platformName,
      windowActions: const UnsupportedWindowActions(),
    );
  }

  setUp(() async {
    dataDir = await Directory.systemTemp.createTemp('mio-api');
  });

  tearDown(() async {
    await active?.shutdown();
    active = null;
    try {
      await dataDir.delete(recursive: true);
    } on FileSystemException {
      // Ignore leftovers from a killed sidecar.
    }
  });

  test('process APIs are rejected on Android', () async {
    final api = createApi('android');

    await expectLater(
      api.call('process.spawn', <String, dynamic>{'path': 'helper.exe'}),
      throwsA(
        isA<MioApiException>()
            .having((error) => error.code, 'code', 'UNSUPPORTED')
            .having((error) => error.message, 'message', contains('Windows')),
      ),
    );
  });

  test(
    'process APIs reach the manager on Windows',
    () async {
      final api = createApi('windows');

      expect(await api.call('process.list', <String, dynamic>{}), isEmpty);
      await expectLater(
        api.call('process.spawn', <String, dynamic>{'path': 'missing-helper.exe'}),
        throwsA(
          isA<MioApiException>()
              .having((error) => error.code, 'code', 'PROCESS_NOT_FOUND'),
        ),
      );
    },
    skip: Platform.isWindows ? false : 'Windows only',
  );
}
