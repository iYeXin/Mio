import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/http_range.dart';

void main() {
  group('parseByteRange', () {
    test('returns null for a missing header', () {
      expect(parseByteRange(null, 100), isNull);
    });

    test('returns null for an empty file', () {
      expect(parseByteRange('bytes=0-10', 0), isNull);
    });

    test('parses an explicit start and end', () {
      final range = parseByteRange('bytes=10-19', 100);
      expect(range?.start, 10);
      expect(range?.end, 19);
    });

    test('parses an open-ended range', () {
      final range = parseByteRange('bytes=90-', 100);
      expect(range?.start, 90);
      expect(range?.end, 99);
    });

    test('clamps an end past the file size', () {
      final range = parseByteRange('bytes=90-500', 100);
      expect(range?.start, 90);
      expect(range?.end, 99);
    });

    test('parses a suffix range', () {
      final range = parseByteRange('bytes=-10', 100);
      expect(range?.start, 90);
      expect(range?.end, 99);
    });

    test('clamps a suffix larger than the file', () {
      final range = parseByteRange('bytes=-500', 100);
      expect(range?.start, 0);
      expect(range?.end, 99);
    });

    test('rejects a start past the file size', () {
      expect(parseByteRange('bytes=100-', 100), isNull);
    });

    test('rejects a reversed range', () {
      expect(parseByteRange('bytes=50-10', 100), isNull);
    });

    test('ignores a malformed unit', () {
      expect(parseByteRange('items=0-10', 100), isNull);
    });

    test('uses the first range of a multi-range request', () {
      final range = parseByteRange('bytes=0-4, 10-14', 100);
      expect(range?.start, 0);
      expect(range?.end, 4);
    });
  });
}
