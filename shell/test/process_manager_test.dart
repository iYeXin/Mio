import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/errors.dart';
import 'package:mio_shell/src/process_manager.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory parent;
  late Directory root;
  late Directory outside;
  late List<MapEntry<String, Object?>> events;

  MioProcessManager createManager({List<String>? roots}) => MioProcessManager(
        roots: roots ?? <String>[root.path],
        emit: (name, data) => events.add(MapEntry(name, data)),
      );

  Matcher throwsMioCode(String code) => throwsA(
        isA<MioApiException>().having((error) => error.code, 'code', code),
      );

  setUp(() async {
    parent = await Directory.systemTemp.createTemp('mio-process');
    root = Directory(p.join(parent.path, 'root'));
    outside = Directory(p.join(parent.path, 'outside'));
    await root.create();
    await outside.create();
    events = <MapEntry<String, Object?>>[];
  });

  tearDown(() async {
    if (await parent.exists()) {
      try {
        await parent.delete(recursive: true);
      } on FileSystemException {
        // A killed sidecar can keep a file handle open for a moment.
      }
    }
  });

  group('path policy', () {
    test('resolves a relative executable inside the root', () async {
      final file = File(p.join(root.path, 'sidecar', 'helper.exe'));
      await file.parent.create(recursive: true);
      await file.writeAsBytes(<int>[0]);

      final resolved = await createManager().resolveExecutable('sidecar/helper.exe');

      // resolveSymbolicLinks also expands Windows 8.3 short names, so compare
      // against the canonical path rather than the raw one.
      expect(p.equals(resolved, await file.resolveSymbolicLinks()), isTrue,
          reason: resolved);
    });

    test('resolves an absolute executable inside the root', () async {
      final file = File(p.join(root.path, 'helper.exe'));
      await file.writeAsBytes(<int>[0]);

      final resolved = await createManager().resolveExecutable(file.path);

      expect(p.equals(resolved, await file.resolveSymbolicLinks()), isTrue);
    });

    test('rejects a relative path that climbs out of the root', () async {
      final evil = File(p.join(outside.path, 'evil.exe'));
      await evil.writeAsBytes(<int>[0]);

      await expectLater(
        createManager().resolveExecutable('../outside/evil.exe'),
        throwsMioCode('PROCESS_FORBIDDEN'),
      );
    });

    test('rejects an absolute path outside the roots', () async {
      final evil = File(p.join(outside.path, 'evil.exe'));
      await evil.writeAsBytes(<int>[0]);

      await expectLater(
        createManager().resolveExecutable(evil.path),
        throwsMioCode('PROCESS_FORBIDDEN'),
      );
    });

    test('reports the paths it tried when the executable is missing', () async {
      await expectLater(
        createManager().resolveExecutable('missing.exe'),
        throwsA(
          isA<MioApiException>()
              .having((error) => error.code, 'code', 'PROCESS_NOT_FOUND')
              .having((error) => '$error.message', 'message', contains('missing.exe')),
        ),
      );
    });

    test('refuses a directory where an executable is expected', () async {
      await Directory(p.join(root.path, 'folder.exe')).create();

      await expectLater(
        createManager().resolveExecutable('folder.exe'),
        throwsMioCode('PROCESS_NOT_FOUND'),
      );
    });
  });

  group('parameter validation', () {
    test('rejects an unknown process id before touching stdin', () async {
      await expectLater(
        createManager().call('process.write', <String, dynamic>{'id': '42', 'data': ''}),
        throwsMioCode('PROCESS_NOT_FOUND'),
      );
    });

    test('rejects an unknown process id carrying invalid base64', () async {
      await expectLater(
        createManager().call('process.write', <String, dynamic>{'id': 'x', 'data': '***'}),
        throwsMioCode('PROCESS_NOT_FOUND'),
      );
    });

    test('rejects an unknown process method', () async {
      await expectLater(
        createManager().call('process.fork', <String, dynamic>{}),
        throwsMioCode('METHOD_NOT_FOUND'),
      );
    });

    test('lists nothing before anything is started', () async {
      expect(await createManager().call('process.list', <String, dynamic>{}), isEmpty);
    });
  });

  group('chunking', () {
    test('splits large payloads into bounded base64 chunks', () {
      final bytes = List<int>.generate(mioProcessChunkSize * 2 + 7, (i) => i % 256);

      final chunks = mioProcessChunks(bytes).toList();

      expect(chunks, hasLength(3));
      final rebuilt = chunks.expand(base64Decode).toList();
      expect(rebuilt, bytes);
    });

    test('emits nothing for empty input', () {
      expect(mioProcessChunks(const <int>[]), isEmpty);
    });
  });

  group('windows sidecars', () {
    final system32 = Platform.environment['SystemRoot'] == null
        ? null
        : p.join(Platform.environment['SystemRoot']!, 'System32');
    final findstr = system32 == null ? null : p.join(system32, 'findstr.exe');
    final available =
        Platform.isWindows && findstr != null && File(findstr).existsSync();

    test(
      'writes stdin, reads stdout and reports the exit code',
      () async {
        final manager = createManager(roots: <String>[system32!]);

        final spawn = await manager.call('process.spawn', <String, dynamic>{
          'path': findstr,
          'args': <String>['pong'],
        }) as Map<String, Object?>;

        await manager.call('process.write', <String, dynamic>{
          'id': spawn['id'],
          'data': base64Encode(utf8.encode('hello\npong\n')),
        });
        await manager.call('process.closeStdin', <String, dynamic>{'id': spawn['id']});

        final exit = await _waitForEvent(events, 'process.exit');
        expect(exit['code'], 0);

        final output = await _stdoutWithin(events, 'pong');
        expect(output, contains('pong'));
      },
      skip: available ? false : 'Windows findstr.exe not available',
    );

    test(
      'kills a process that is waiting on stdin',
      () async {
        final manager = createManager(roots: <String>[system32!]);

        final spawn = await manager.call('process.spawn', <String, dynamic>{
          'path': findstr,
          'args': <String>['never'],
        }) as Map<String, Object?>;

        final kill = await manager.call('process.kill', <String, dynamic>{
          'id': spawn['id'],
        }) as Map<String, Object?>;

        expect(kill['killed'], isTrue);
        final exit = await _waitForEvent(events, 'process.exit');
        expect(exit['id'], spawn['id']);
        expect(manager.runningCount, 0);
      },
      skip: available ? false : 'Windows findstr.exe not available',
    );
  });
}

Future<Map<String, Object?>> _waitForEvent(
  List<MapEntry<String, Object?>> events,
  String name, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    for (final entry in events) {
      if (entry.key == name) return entry.value as Map<String, Object?>;
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('event $name never arrived; saw ${events.map((entry) => entry.key).toList()}');
}

Future<String> _stdoutWithin(
  List<MapEntry<String, Object?>> events,
  String needle, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  var decoded = '';
  while (DateTime.now().isBefore(deadline)) {
    final buffer = StringBuffer();
    for (final entry in events) {
      if (entry.key != 'process.stdout') continue;
      buffer.write(utf8.decode(base64Decode((entry.value as Map)['data'] as String), allowMalformed: true));
    }
    decoded = buffer.toString();
    if (decoded.contains(needle)) return decoded;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  return decoded;
}
