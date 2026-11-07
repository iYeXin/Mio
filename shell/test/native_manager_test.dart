import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/errors.dart';
import 'package:mio_shell/src/native_manager.dart';

void main() {
  late Directory root;
  late List<MapEntry<String, Object?>> events;

  MioNativeManager createManager({String platformName = 'windows', String? abi}) {
    return MioNativeManager(
      extractRoot: Directory('${root.path}/native'),
      platformName: platformName,
      abiName: abi ?? 'x64',
      emit: (name, data) => events.add(MapEntry(name, data)),
    );
  }

  Matcher throwsCode(String code) =>
      throwsA(isA<MioApiException>().having((error) => error.code, 'code', code));

  setUp(() async {
    root = await Directory.systemTemp.createTemp('mio-native');
    events = <MapEntry<String, Object?>>[];
  });

  tearDown(() async {
    await root.delete(recursive: true).catchError((_) => root);
  });

  test('refuses to load without an app archive', () async {
    await expectLater(
      createManager().call('native.load', <String, dynamic>{'name': 'echo'}),
      throwsA(
        isA<MioApiException>()
            .having((error) => error.code, 'code', 'NATIVE_UNAVAILABLE')
            .having((error) => error.message, 'message', contains('packaged build')),
      ),
    );
  });

  test('refuses unsupported platforms', () async {
    await expectLater(
      createManager(platformName: 'linux').call('native.load', <String, dynamic>{
        'name': 'echo',
      }),
      throwsCode('NATIVE_UNAVAILABLE'),
    );
  });

  test('starts with an empty library list', () async {
    expect(await createManager().call('native.list', <String, dynamic>{}), isEmpty);
  });

  test('rejects a handle that was never loaded', () async {
    await expectLater(
      createManager().call('native.call', <String, dynamic>{
        'handle': '42',
        'symbol': 'add',
        'signature': 'i32(i32,i32)',
        'args': <Object?>[1, 2],
      }),
      throwsCode('NATIVE_NOT_LOADED'),
    );
  });

  test('rejects an unknown native method', () async {
    await expectLater(
      createManager().call('native.fork', <String, dynamic>{}),
      throwsCode('METHOD_NOT_FOUND'),
    );
  });

  test('stop refuses an unknown handle', () async {
    await expectLater(
      createManager().call('native.stop', <String, dynamic>{'handle': '7'}),
      throwsCode('NATIVE_NOT_LOADED'),
    );
  });

  test('emit refuses an unknown handle', () async {
    await expectLater(
      createManager().call('native.emit', <String, dynamic>{'handle': '7', 'event': 1}),
      throwsCode('NATIVE_NOT_LOADED'),
    );
  });

  test('rejects names that try to escape the native directory', () async {
    for (final name in <String>['../evil', 'a/b', '..', '.hidden']) {
      await expectLater(
        createManager().call('native.load', <String, dynamic>{'name': name}),
        throwsA(isA<MioApiException>()),
        reason: name,
      );
    }
  });

  test('uses dll on Windows and so elsewhere', () {
    expect(createManager(platformName: 'windows').extension, 'dll');
    expect(createManager(platformName: 'android', abi: 'arm64').extension, 'so');
  });
}
