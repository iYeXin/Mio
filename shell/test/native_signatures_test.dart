import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/native_signatures.dart';

void main() {
  group('parse', () {
    test('reads return type and arguments', () {
      final signature = NativeSignature.parse('i32(i32,i32)');

      expect(signature.returnType, 'i32');
      expect(signature.arguments, <String>['i32', 'i32']);
      expect(signature.key, 'i32,i32>i32');
      expect(signature.describe(), 'i32(i32,i32)');
    });

    test('ignores whitespace', () {
      final signature = NativeSignature.parse(' f64 ( str , i32 ) ');

      expect(signature.returnType, 'f64');
      expect(signature.arguments, <String>['str', 'i32']);
    });

    test('accepts an empty argument list', () {
      expect(NativeSignature.parse('void()').arguments, isEmpty);
    });

    test('rejects a missing parenthesis', () {
      expect(
        () => NativeSignature.parse('i32'),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects an unknown return type', () {
      expect(
        () => NativeSignature.parse('bool(i32)'),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects an unknown argument type', () {
      expect(
        () => NativeSignature.parse('i32(ptr)'),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects more than three arguments', () {
      expect(
        () => NativeSignature.parse('i32(i32,i32,i32,i32)'),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects a valid but unsupported shape', () {
      expect(
        () => NativeSignature.parse('i32(i64,f64)'),
        throwsA(
          isA<NativeSignatureException>().having(
            (error) => error.message,
            'message',
            contains('not one of the supported shapes'),
          ),
        ),
      );
    });

    test('every supported signature parses', () {
      expect(
        supportedSignatures,
        hasLength(supportedShapes.length * NativeSignature.returnTypes.length),
      );
      for (final shape in supportedShapes) {
        final arguments = shape.isEmpty ? <String>[] : shape.split(',');
        for (final returnType in NativeSignature.returnTypes) {
          final text = '$returnType(${arguments.join(',')})';
          final signature = NativeSignature.parse(text);
          expect(signature.returnType, returnType, reason: text);
          expect(signature.arguments, arguments, reason: text);
        }
      }
    });
  });

  group('coerce', () {
    test('keeps integers and doubles', () {
      final signature = NativeSignature.parse('f64(i32,f64)');

      expect(signature.coerce(<Object?>[3, 2]), <Object?>[3, 2.0]);
    });

    test('rejects a wrong argument count', () {
      final signature = NativeSignature.parse('i32(i32,i32)');

      expect(
        () => signature.coerce(<Object?>[1]),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects a string where an integer is expected', () {
      final signature = NativeSignature.parse('i32(i32)');

      expect(
        () => signature.coerce(<Object?>['nope']),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('rejects an integer that does not fit in i32', () {
      final signature = NativeSignature.parse('i32(i32)');

      expect(
        () => signature.coerce(<Object?>[2147483648]),
        throwsA(isA<NativeSignatureException>()),
      );
    });

    test('accepts i64 beyond the i32 range', () {
      final signature = NativeSignature.parse('i64(i64)');

      expect(signature.coerce(<Object?>[9007199254740991]), <Object?>[9007199254740991]);
    });

    test('rejects a non-string for str', () {
      final signature = NativeSignature.parse('i32(str)');

      expect(
        () => signature.coerce(<Object?>[42]),
        throwsA(isA<NativeSignatureException>()),
      );
    });
  });
}
