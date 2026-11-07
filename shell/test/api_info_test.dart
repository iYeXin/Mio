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
    dataDir = await Directory.systemTemp.createTemp('mio-info');
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

  test('app.info reports the platform and its capabilities', () async {
    final api = createApi('windows');
    final info = await api.call('app.info', <String, dynamic>{}) as Map<String, dynamic>;
    final features = info['features'] as Map<String, dynamic>;

    expect(info['platform'], 'windows');
    expect(info['apiVersion'], mioApiVersion);
    expect(features['process'], isTrue);
    expect(features['window'], isFalse);
    // No app archive in this test, which matches dev mode.
    expect(info['dev'], isTrue);
    expect(features['native'], isFalse);
  });

  test('app.info hides native and process features on Android', () async {
    final api = createApi('android');
    final info = await api.call('app.info', <String, dynamic>{}) as Map<String, dynamic>;
    final features = info['features'] as Map<String, dynamic>;

    expect(features['process'], isFalse);
    expect(features['window'], isFalse);
    expect(features['native'], isFalse);
  });

  test('platform.info reports the ABI', () async {
    final api = createApi('android');
    final info = await api.call('platform.info', <String, dynamic>{}) as Map<String, dynamic>;

    expect(info['platform'], 'android');
    expect(info['abi'], isA<String>());
    expect((info['abi'] as String).isNotEmpty, isTrue);
  });

  test('app.paths keeps the writable sandbox inside the data root', () async {
    final api = createApi('windows');
    final paths = await api.call('app.paths', <String, dynamic>{}) as Map<String, dynamic>;

    expect(paths['data'], dataDir.path);
    expect(paths['app'], '${dataDir.path}${Platform.pathSeparator}app');
    expect(paths['app'] as String, startsWith(paths['data'] as String));
    expect(paths['native'] as String, startsWith(paths['data'] as String));
    expect(paths['install'], isNotEmpty);
    expect(paths['temp'], isNotEmpty);
  });

  test('shell.openPath is rejected on Android', () async {
    final api = createApi('android');

    await expectLater(
      api.call('shell.openPath', <String, dynamic>{'path': 'notes.txt'}),
      throwsA(
        isA<MioApiException>()
            .having((error) => error.code, 'code', 'UNSUPPORTED')
            .having((error) => error.message, 'message', contains('Windows')),
      ),
    );
  }, skip: Platform.isWindows ? false : 'Windows only');

  test('shell.openPath reports a missing file', () async {
    final api = createApi('windows');

    await expectLater(
      api.call('shell.openPath', <String, dynamic>{'path': 'missing.txt'}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'FS_NOT_FOUND')),
    );
  }, skip: Platform.isWindows ? false : 'Windows only');

  test('shell.openPath refuses to escape the sandbox', () async {
    final api = createApi('windows');

    await expectLater(
      api.call('shell.openPath', <String, dynamic>{'path': '../outside.txt'}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'FS_FORBIDDEN')),
    );
  }, skip: Platform.isWindows ? false : 'Windows only');

  test('window actions are unsupported here', () async {
    final api = createApi('android');

    await expectLater(
      api.call('window.setFullScreen', <String, dynamic>{'fullScreen': true}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'UNSUPPORTED')),
    );
    await expectLater(
      api.call('window.moveTo', <String, dynamic>{'x': 10, 'y': 20}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'UNSUPPORTED')),
    );
  });

  test('app.info carries a start time and uptime', () async {
    final api = createApi('windows');
    final info = await api.call('app.info', <String, dynamic>{}) as Map<String, dynamic>;

    expect(DateTime.tryParse(info['startedAt'] as String), isNotNull);
    expect(info['uptimeMs'], isA<int>());
    expect(info['uptimeMs'] as int, greaterThanOrEqualTo(0));
  });

  test('app.log appends a timestamped line and returns its path', () async {
    final api = createApi('windows');

    final result = await api.call('app.log', <String, dynamic>{
      'level': 'warn',
      'message': 'hello log',
    }) as Map<String, dynamic>;
    await api.call('app.log', <String, dynamic>{'level': 'info', 'message': 'second'});

    expect(result['path'], 'logs/mio.log');
    final text = await api.call('fs.readText', <String, dynamic>{'path': 'logs/mio.log'}) as String;
    expect(text, contains('warn hello log'));
    expect(text, contains('info second'));
    expect(text.split('\n').where((line) => line.isNotEmpty), hasLength(2));
  });

  test('app.log rejects an unknown level', () async {
    final api = createApi('windows');

    await expectLater(
      api.call('app.log', <String, dynamic>{'level': 'trace', 'message': 'x'}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'BAD_REQUEST')),
    );
  });

  test('fs.appendText keeps previous content', () async {
    final api = createApi('windows');

    await api.call('fs.appendText', <String, dynamic>{'path': 'a/b.txt', 'text': 'one\n'});
    await api.call('fs.appendText', <String, dynamic>{'path': 'a/b.txt', 'text': 'two\n'});

    final text = await api.call('fs.readText', <String, dynamic>{'path': 'a/b.txt'}) as String;
    expect(text, 'one\ntwo\n');
  });

  test('shell.reveal is rejected on Android', () async {
    final api = createApi('android');

    await expectLater(
      api.call('shell.reveal', <String, dynamic>{'path': 'notes.txt'}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'UNSUPPORTED')),
    );
  }, skip: Platform.isWindows ? false : 'Windows only');

  test('shell.reveal reports a missing path', () async {
    final api = createApi('windows');

    await expectLater(
      api.call('shell.reveal', <String, dynamic>{'path': 'missing'}),
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', 'FS_NOT_FOUND')),
    );
  }, skip: Platform.isWindows ? false : 'Windows only');
}
