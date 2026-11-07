import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/atomic_file.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('mio-atomic');
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('writes a new file and leaves no .part behind', () async {
    final target = File('${root.path}/notes/hello.txt');

    await atomicWriteBytes(target, <int>[104, 105]);

    expect(await target.readAsString(), 'hi');
    expect(await File('${target.path}.part').exists(), isFalse);
  });

  test('replaces existing content', () async {
    final target = File('${root.path}/data.bin');
    await target.writeAsBytes(<int>[1, 2, 3]);

    await atomicWriteBytes(target, <int>[9]);

    expect(await target.readAsBytes(), <int>[9]);
    expect(await File('${target.path}.part').exists(), isFalse);
  });

  test('cleans up the .part file when the source fails mid-write', () async {
    final target = File('${root.path}/stream.bin');
    Stream<List<int>> failing() async* {
      yield <int>[1, 2, 3];
      throw const FileSystemException('disk on fire');
    }

    await expectLater(atomicWriteStream(target, failing()), throwsA(isA<FileSystemException>()));

    expect(await target.exists(), isFalse);
    expect(await File('${target.path}.part').exists(), isFalse);
  });

  test('keeps the previous content when the write fails', () async {
    final target = File('${root.path}/keep.bin');
    await atomicWriteBytes(target, <int>[1, 2, 3]);
    Stream<List<int>> failing() async* {
      yield <int>[9];
      throw const FileSystemException('disk on fire');
    }

    await expectLater(atomicWriteStream(target, failing()), throwsA(isA<FileSystemException>()));

    expect(await target.readAsBytes(), <int>[1, 2, 3]);
  });

  test('writes a stream into a nested directory', () async {
    final target = File('${root.path}/a/b/c/file.txt');

    await atomicWriteStream(target, Stream<List<int>>.value(<int>[65, 66]));

    expect(await target.readAsString(), 'AB');
  });
}
