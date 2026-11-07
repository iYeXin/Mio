import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/api_version.dart';

void main() {
  group('ApiVersion.tryParse', () {
    test('parses major.minor.patch', () {
      final version = ApiVersion.tryParse('1.2.3');
      expect(version?.major, 1);
      expect(version?.minor, 2);
      expect(version?.patch, 3);
    });

    test('pads missing components', () {
      final version = ApiVersion.tryParse('2');
      expect(version?.toString(), '2.0.0');
    });

    test('rejects invalid input', () {
      expect(ApiVersion.tryParse('1.x'), isNull);
      expect(ApiVersion.tryParse('1.2.3.4'), isNull);
      expect(ApiVersion.tryParse(''), isNull);
      expect(ApiVersion.tryParse('-1.0.0'), isNull);
    });
  });

  group('checkApiCompatibility', () {
    test('accepts when no requirement is declared', () {
      expect(checkApiCompatibility(runtime: '1.0.0'), isNull);
      expect(checkApiCompatibility(runtime: '1.0.0', required: '  '), isNull);
    });

    test('accepts an equal version', () {
      expect(
        checkApiCompatibility(runtime: '1.0.0', required: '1.0.0'),
        isNull,
      );
    });

    test('accepts an older minor requirement', () {
      expect(
        checkApiCompatibility(runtime: '1.4.0', required: '1.2.0'),
        isNull,
      );
    });

    test('rejects a newer minor requirement', () {
      final reason = checkApiCompatibility(runtime: '1.2.0', required: '1.4.0');
      expect(reason, isNotNull);
      expect(reason, contains('1.4.0'));
      expect(reason, contains('1.2.0'));
    });

    test('rejects a different major version', () {
      final reason = checkApiCompatibility(runtime: '1.0.0', required: '2.0.0');
      expect(reason, isNotNull);
      expect(reason, contains('not compatible'));
    });

    test('reports an invalid requirement', () {
      final reason = checkApiCompatibility(runtime: '1.0.0', required: 'latest');
      expect(reason, contains('invalid'));
    });
  });
}
