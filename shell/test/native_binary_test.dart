import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/native_binary.dart';

void main() {
  Uint8List elf({required int machine, int length = 64}) {
    final bytes = Uint8List(length);
    bytes[0] = 0x7f;
    bytes[1] = 0x45; // E
    bytes[2] = 0x4c; // L
    bytes[3] = 0x46; // F
    bytes[4] = 2; // 64-bit
    bytes[5] = 1; // little endian
    bytes[18] = machine & 0xff;
    bytes[19] = (machine >> 8) & 0xff;
    return bytes;
  }

  Uint8List pe({required int machine, int length = 512}) {
    final bytes = Uint8List(length);
    bytes[0] = 0x4d; // M
    bytes[1] = 0x5a; // Z
    const peOffset = 0x40;
    bytes[0x3c] = peOffset;
    bytes[peOffset] = 0x50; // P
    bytes[peOffset + 1] = 0x45; // E
    bytes[peOffset + 4] = machine & 0xff;
    bytes[peOffset + 5] = (machine >> 8) & 0xff;
    return bytes;
  }

  group('inspectNativeBinary', () {
    test('recognises an arm64 ELF', () {
      final info = inspectNativeBinary(elf(machine: 0xb7));

      expect(info.format, 'elf');
      expect(info.abi, 'arm64');
    });

    test('recognises an x86_64 ELF', () {
      expect(inspectNativeBinary(elf(machine: 0x3e)).abi, 'x64');
    });

    test('keeps the format when the machine is unknown', () {
      final info = inspectNativeBinary(elf(machine: 0x1234));

      expect(info.format, 'elf');
      expect(info.abi, isNull);
      expect(info.description, 'elf');
    });

    test('recognises an x64 PE', () {
      final info = inspectNativeBinary(pe(machine: 0x8664));

      expect(info.format, 'pe');
      expect(info.abi, 'x64');
      expect(info.description, 'pe/x64');
    });

    test('recognises a 32-bit PE', () {
      expect(inspectNativeBinary(pe(machine: 0x014c)).abi, 'x86');
    });

    test('rejects unrelated bytes', () {
      expect(
        () => inspectNativeBinary(Uint8List.fromList(<int>[1, 2, 3, 4, 5])),
        throwsA(isA<NativeBinaryException>()),
      );
    });

    test('rejects an MZ file without a PE header', () {
      final bytes = Uint8List(128)..[0] = 0x4d;
      bytes[1] = 0x5a;

      expect(
        () => inspectNativeBinary(bytes),
        throwsA(
          isA<NativeBinaryException>().having(
            (error) => error.message,
            'message',
            contains('no PE header'),
          ),
        ),
      );
    });

    test('rejects a truncated ELF header', () {
      final truncated = Uint8List.fromList(<int>[0x7f, 0x45, 0x4c, 0x46, 2, 1, 0, 0, 0, 0]);

      expect(
        () => inspectNativeBinary(truncated),
        throwsA(isA<NativeBinaryException>()),
      );
    });
  });

  group('nativeCacheMarker', () {
    test('is stable for the same archive entry', () {
      final first = nativeCacheMarker(offset: 100, size: 2000, archiveModifiedMs: 42);
      final second = nativeCacheMarker(offset: 100, size: 2000, archiveModifiedMs: 42);

      expect(first, second);
    });

    test('changes when the archive was rebuilt', () {
      expect(
        nativeCacheMarker(offset: 100, size: 2000, archiveModifiedMs: 42),
        isNot(nativeCacheMarker(offset: 100, size: 2000, archiveModifiedMs: 43)),
      );
    });

    test('changes when the entry moved', () {
      expect(
        nativeCacheMarker(offset: 100, size: 2000, archiveModifiedMs: 42),
        isNot(nativeCacheMarker(offset: 200, size: 2000, archiveModifiedMs: 42)),
      );
    });

    test('keeps the same size distinguishable after a rebuild', () {
      final before = nativeCacheMarker(offset: 10, size: 500, archiveModifiedMs: 1);
      final after = nativeCacheMarker(offset: 10, size: 500, archiveModifiedMs: 2);

      expect(before, isNot(after));
    });
  });

  group('describeLoadFailure', () {
    test('explains a 4 KB page alignment failure', () {
      final text = describeLoadFailure(
        'dlopen failed: "…/libx.so" program alignment (4096) cannot be smaller than system page size (16384)',
        abi: 'arm64',
      );

      expect(text, contains('max-page-size=16384'));
    });

    test('explains a missing dependency', () {
      final text = describeLoadFailure(
        'dlopen failed: library "libdep.so" not found: needed by /data/…/libparent.so in namespace clns-9',
        abi: 'arm64',
      );

      expect(text, contains('load it first'));
    });

    test('explains a namespace rejection', () {
      final text = describeLoadFailure(
        'library "…/libx.so" is not accessible for the namespace "classloader-namespace"',
        abi: 'arm64',
      );

      expect(text, contains('absolute path'));
    });

    test('passes unrelated messages through unchanged', () {
      const raw = 'something else went wrong';

      expect(describeLoadFailure(raw, abi: 'x64'), raw);
    });
  });
}
