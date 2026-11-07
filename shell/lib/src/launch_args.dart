import 'dart:ffi';
import 'package:ffi/ffi.dart';
import 'dart:io';

/// The command line the application was started with, minus the executable.
///
/// Flutter's desktop embedder does not pass arguments to Dart's `main`, so the
/// Windows command line is read directly and split with the same quoting rules
/// the C runtime uses.
List<String> mioLaunchArguments() {
  if (!Platform.isWindows) return const <String>[];
  try {
    final kernel32 = DynamicLibrary.open('kernel32.dll');
    final getCommandLine = kernel32.lookupFunction<
        Pointer<Utf16> Function(),
        Pointer<Utf16> Function()>('GetCommandLineW');
    final commandLine = getCommandLine();
    if (commandLine == nullptr) return const <String>[];
    final parts = _splitWindowsCommandLine(commandLine.toDartString());
    return parts.length <= 1 ? const <String>[] : parts.sublist(1);
  } catch (_) {
    return const <String>[];
  }
}

/// Splits a Windows command line into arguments.
///
/// Follows the rules used by `CommandLineToArgvW`: double quotes group, `\"`
/// is a literal quote, and backslashes before a quote escape it in pairs.
List<String> _splitWindowsCommandLine(String commandLine) {
  final args = <String>[];
  final current = StringBuffer();
  var inQuotes = false;
  var hasArgument = false;
  var backslashes = 0;

  void flush() {
    args.add(current.toString());
    current.clear();
    hasArgument = false;
  }

  for (final unit in commandLine.codeUnits) {
    final char = String.fromCharCode(unit);
    if (char == '\\') {
      backslashes += 1;
      continue;
    }
    if (char == '"') {
      // Backslashes before a quote: pairs become one literal backslash.
      current.write('\\' * (backslashes ~/ 2));
      if (backslashes.isOdd) {
        current.write('"');
      } else {
        inQuotes = !inQuotes;
      }
      backslashes = 0;
      hasArgument = true;
      continue;
    }
    current.write('\\' * backslashes);
    backslashes = 0;
    if (!inQuotes && (char == ' ' || char == '\t')) {
      if (hasArgument || current.isNotEmpty) flush();
      continue;
    }
    current.write(char);
    hasArgument = true;
  }

  current.write('\\' * backslashes);
  if (hasArgument || current.isNotEmpty) flush();
  return args;
}
