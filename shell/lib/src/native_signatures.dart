import 'dart:ffi';

import 'package:ffi/ffi.dart';

/// A parsed signature string such as `i32(i32,f64)` or `void(str)`.
///
/// Mio deliberately supports a small, fixed set of scalar signatures instead of
/// arbitrary `dart:ffi` bindings: the shell is prebuilt, so every callable shape
/// has to exist at template build time. See [supportedSignatures].
class NativeSignature {
  const NativeSignature(this.returnType, this.arguments);

  final String returnType;
  final List<String> arguments;

  static const Set<String> valueTypes = <String>{'i32', 'i64', 'f64', 'str'};
  static const Set<String> returnTypes = <String>{'void', 'i32', 'i64', 'f64'};
  static const int maxArguments = 3;

  /// Parses `ret(arg,arg,...)`; whitespace is ignored.
  static NativeSignature parse(String input) {
    final normalized = input.replaceAll(RegExp(r'\s+'), '');
    final open = normalized.indexOf('(');
    if (open <= 0 || !normalized.endsWith(')')) {
      throw NativeSignatureException(
        'Signature must look like "i32(i32,f64)": $input',
      );
    }
    final returnType = normalized.substring(0, open);
    final inner = normalized.substring(open + 1, normalized.length - 1);
    final arguments = inner.isEmpty ? <String>[] : inner.split(',');

    if (!returnTypes.contains(returnType)) {
      throw NativeSignatureException(
        'Unsupported return type "$returnType" (expected ${returnTypes.join(', ')})',
      );
    }
    if (arguments.length > maxArguments) {
      throw NativeSignatureException(
        'At most $maxArguments arguments are supported, got ${arguments.length}',
      );
    }
    for (final argument in arguments) {
      if (!valueTypes.contains(argument)) {
        throw NativeSignatureException(
          'Unsupported argument type "$argument" (expected ${valueTypes.join(', ')})',
        );
      }
    }

    final signature = NativeSignature(returnType, List<String>.unmodifiable(arguments));
    if (!supportedSignatures.contains(signature.key)) {
      throw NativeSignatureException(
        'Signature ${signature.describe()} is not one of the supported shapes. '
        'See docs/api.md for the list.',
      );
    }
    return signature;
  }

  String get key => '${arguments.join(',')}>$returnType';

  String describe() => '$returnType(${arguments.join(',')})';

  /// Converts JSON values into the Dart values the thunks expect.
  List<Object?> coerce(List<Object?> values) {
    if (values.length != arguments.length) {
      throw NativeSignatureException(
        '${describe()} takes ${arguments.length} argument(s), got ${values.length}',
      );
    }
    final result = <Object?>[];
    for (var index = 0; index < arguments.length; index += 1) {
      final type = arguments[index];
      final value = values[index];
      switch (type) {
        case 'i32':
        case 'i64':
          if (value is! int) {
            throw NativeSignatureException(
              'Argument ${index + 1} of ${describe()} must be an integer',
            );
          }
          if (type == 'i32' && (value < -2147483648 || value > 2147483647)) {
            throw NativeSignatureException(
              'Argument ${index + 1} of ${describe()} does not fit in i32',
            );
          }
          result.add(value);
        case 'f64':
          if (value is! num) {
            throw NativeSignatureException(
              'Argument ${index + 1} of ${describe()} must be a number',
            );
          }
          result.add(value.toDouble());
        case 'str':
          if (value is! String) {
            throw NativeSignatureException(
              'Argument ${index + 1} of ${describe()} must be a string',
            );
          }
          result.add(value);
      }
    }
    return result;
  }
}

class NativeSignatureException implements Exception {
  const NativeSignatureException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Argument shapes the prebuilt shell can call. Keep this list small: every
/// entry costs a `lookupFunction` instantiation in the template.
const List<String> supportedShapes = <String>[
  '',
  'i32',
  'i32,i32',
  'i32,i32,i32',
  'i64',
  'i64,i64',
  'f64',
  'f64,f64',
  'str',
  'str,i32',
  'str,i32,i32',
  'i32,f64',
  'i32,f64,f64',
];

/// Every accepted `signature` string, for docs and error messages.
final Set<String> supportedSignatures = <String>{
  for (final shape in supportedShapes)
    for (final returnType in NativeSignature.returnTypes) '$shape>$returnType',
};

/// Calls [symbol] with [arguments] after checking that [signature] is known.
Object? invokeNative(
  DynamicLibrary library,
  String symbol,
  NativeSignature signature,
  List<Object?> arguments,
) {
  final shape = signature.arguments.join(',');
  final invoker = _shapes[shape];
  if (invoker == null) {
    throw NativeSignatureException(
      'Signature ${signature.describe()} is not supported by this shell build',
    );
  }
  return invoker(library, symbol, arguments, signature.returnType);
}

typedef _Shape =
    Object? Function(
      DynamicLibrary library,
      String symbol,
      List<Object?> arguments,
      String returnType,
    );

R _withCString<R>(String value, R Function(Pointer<Utf8>) body) {
  final pointer = value.toNativeUtf8();
  try {
    return body(pointer);
  } finally {
    malloc.free(pointer);
  }
}

Never _unsupportedReturn(String returnType) =>
    throw NativeSignatureException('Unsupported return type: $returnType');

final Map<String, _Shape> _shapes = <String, _Shape>{
  '': (library, symbol, arguments, returnType) {
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(), void Function()>(symbol)();
        return null;
      case 'i32':
        return library.lookupFunction<Int32 Function(), int Function()>(symbol)();
      case 'i64':
        return library.lookupFunction<Int64 Function(), int Function()>(symbol)();
      case 'f64':
        return library.lookupFunction<Double Function(), double Function()>(symbol)();
    }
    _unsupportedReturn(returnType);
  },
  'i32': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int32), void Function(int)>(symbol)(a);
        return null;
      case 'i32':
        return library.lookupFunction<Int32 Function(Int32), int Function(int)>(symbol)(a);
      case 'i64':
        return library.lookupFunction<Int64 Function(Int32), int Function(int)>(symbol)(a);
      case 'f64':
        return library.lookupFunction<Double Function(Int32), double Function(int)>(symbol)(a);
    }
    _unsupportedReturn(returnType);
  },
  'i32,i32': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    final b = arguments[1] as int;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int32, Int32), void Function(int, int)>(symbol)(a, b);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Int32, Int32), int Function(int, int)>(symbol)(a, b);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Int32, Int32), int Function(int, int)>(symbol)(a, b);
      case 'f64':
        return library
            .lookupFunction<Double Function(Int32, Int32), double Function(int, int)>(symbol)(a, b);
    }
    _unsupportedReturn(returnType);
  },
  'i32,i32,i32': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    final b = arguments[1] as int;
    final c = arguments[2] as int;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int32, Int32, Int32), void Function(int, int, int)>(
          symbol,
        )(a, b, c);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Int32, Int32, Int32), int Function(int, int, int)>(
              symbol,
            )(a, b, c);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Int32, Int32, Int32), int Function(int, int, int)>(
              symbol,
            )(a, b, c);
      case 'f64':
        return library
            .lookupFunction<Double Function(Int32, Int32, Int32), double Function(int, int, int)>(
              symbol,
            )(a, b, c);
    }
    _unsupportedReturn(returnType);
  },
  'i64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int64), void Function(int)>(symbol)(a);
        return null;
      case 'i32':
        return library.lookupFunction<Int32 Function(Int64), int Function(int)>(symbol)(a);
      case 'i64':
        return library.lookupFunction<Int64 Function(Int64), int Function(int)>(symbol)(a);
      case 'f64':
        return library.lookupFunction<Double Function(Int64), double Function(int)>(symbol)(a);
    }
    _unsupportedReturn(returnType);
  },
  'i64,i64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    final b = arguments[1] as int;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int64, Int64), void Function(int, int)>(symbol)(a, b);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Int64, Int64), int Function(int, int)>(symbol)(a, b);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Int64, Int64), int Function(int, int)>(symbol)(a, b);
      case 'f64':
        return library
            .lookupFunction<Double Function(Int64, Int64), double Function(int, int)>(symbol)(a, b);
    }
    _unsupportedReturn(returnType);
  },
  'f64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as double;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Double), void Function(double)>(symbol)(a);
        return null;
      case 'i32':
        return library.lookupFunction<Int32 Function(Double), int Function(double)>(symbol)(a);
      case 'i64':
        return library.lookupFunction<Int64 Function(Double), int Function(double)>(symbol)(a);
      case 'f64':
        return library.lookupFunction<Double Function(Double), double Function(double)>(symbol)(a);
    }
    _unsupportedReturn(returnType);
  },
  'f64,f64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as double;
    final b = arguments[1] as double;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Double, Double), void Function(double, double)>(
          symbol,
        )(a, b);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Double, Double), int Function(double, double)>(
              symbol,
            )(a, b);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Double, Double), int Function(double, double)>(
              symbol,
            )(a, b);
      case 'f64':
        return library
            .lookupFunction<Double Function(Double, Double), double Function(double, double)>(
              symbol,
            )(a, b);
    }
    _unsupportedReturn(returnType);
  },
  'str': (library, symbol, arguments, returnType) {
    return _withCString(arguments[0] as String, (text) {
      switch (returnType) {
        case 'void':
          library.lookupFunction<Void Function(Pointer<Utf8>), void Function(Pointer<Utf8>)>(
            symbol,
          )(text);
          return null;
        case 'i32':
          return library
              .lookupFunction<Int32 Function(Pointer<Utf8>), int Function(Pointer<Utf8>)>(
                symbol,
              )(text);
        case 'i64':
          return library
              .lookupFunction<Int64 Function(Pointer<Utf8>), int Function(Pointer<Utf8>)>(
                symbol,
              )(text);
        case 'f64':
          return library
              .lookupFunction<Double Function(Pointer<Utf8>), double Function(Pointer<Utf8>)>(
                symbol,
              )(text);
      }
      return _unsupportedReturn(returnType);
    });
  },
  'str,i32': (library, symbol, arguments, returnType) {
    final a = arguments[0] as String;
    final b = arguments[1] as int;
    return _withCString(a, (text) {
      switch (returnType) {
        case 'void':
          library
              .lookupFunction<
                Void Function(Pointer<Utf8>, Int32),
                void Function(Pointer<Utf8>, int)
              >(symbol)(text, b);
          return null;
        case 'i32':
          return library
              .lookupFunction<
                Int32 Function(Pointer<Utf8>, Int32),
                int Function(Pointer<Utf8>, int)
              >(symbol)(text, b);
        case 'i64':
          return library
              .lookupFunction<
                Int64 Function(Pointer<Utf8>, Int32),
                int Function(Pointer<Utf8>, int)
              >(symbol)(text, b);
        case 'f64':
          return library
              .lookupFunction<
                Double Function(Pointer<Utf8>, Int32),
                double Function(Pointer<Utf8>, int)
              >(symbol)(text, b);
      }
      return _unsupportedReturn(returnType);
    });
  },
  'str,i32,i32': (library, symbol, arguments, returnType) {
    final a = arguments[0] as String;
    final b = arguments[1] as int;
    final c = arguments[2] as int;
    return _withCString(a, (text) {
      switch (returnType) {
        case 'void':
          library
              .lookupFunction<
                Void Function(Pointer<Utf8>, Int32, Int32),
                void Function(Pointer<Utf8>, int, int)
              >(symbol)(text, b, c);
          return null;
        case 'i32':
          return library
              .lookupFunction<
                Int32 Function(Pointer<Utf8>, Int32, Int32),
                int Function(Pointer<Utf8>, int, int)
              >(symbol)(text, b, c);
        case 'i64':
          return library
              .lookupFunction<
                Int64 Function(Pointer<Utf8>, Int32, Int32),
                int Function(Pointer<Utf8>, int, int)
              >(symbol)(text, b, c);
        case 'f64':
          return library
              .lookupFunction<
                Double Function(Pointer<Utf8>, Int32, Int32),
                double Function(Pointer<Utf8>, int, int)
              >(symbol)(text, b, c);
      }
      return _unsupportedReturn(returnType);
    });
  },
  'i32,f64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    final b = arguments[1] as double;
    switch (returnType) {
      case 'void':
        library.lookupFunction<Void Function(Int32, Double), void Function(int, double)>(
          symbol,
        )(a, b);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Int32, Double), int Function(int, double)>(symbol)(a, b);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Int32, Double), int Function(int, double)>(symbol)(a, b);
      case 'f64':
        return library
            .lookupFunction<Double Function(Int32, Double), double Function(int, double)>(
              symbol,
            )(a, b);
    }
    _unsupportedReturn(returnType);
  },
  'i32,f64,f64': (library, symbol, arguments, returnType) {
    final a = arguments[0] as int;
    final b = arguments[1] as double;
    final c = arguments[2] as double;
    switch (returnType) {
      case 'void':
        library
            .lookupFunction<
              Void Function(Int32, Double, Double),
              void Function(int, double, double)
            >(symbol)(a, b, c);
        return null;
      case 'i32':
        return library
            .lookupFunction<Int32 Function(Int32, Double, Double), int Function(int, double, double)>(
              symbol,
            )(a, b, c);
      case 'i64':
        return library
            .lookupFunction<Int64 Function(Int32, Double, Double), int Function(int, double, double)>(
              symbol,
            )(a, b, c);
      case 'f64':
        return library
            .lookupFunction<
              Double Function(Int32, Double, Double),
              double Function(int, double, double)
            >(symbol)(a, b, c);
    }
    _unsupportedReturn(returnType);
  },
};
