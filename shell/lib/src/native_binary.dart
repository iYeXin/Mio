import 'dart:typed_data';

/// What a native library file claims to be, read straight from its header.
///
/// Checking this before `dlopen` turns the two most common mistakes — wrong
/// architecture, or a file that is not a shared library at all — into readable
/// errors instead of linker noise.
class NativeBinaryInfo {
  const NativeBinaryInfo({required this.format, required this.abi});

  /// `elf` or `pe`.
  final String format;

  /// Short ABI name (`arm64`, `x64`, `arm`, `x86`), or null when unknown.
  final String? abi;

  String get description => abi == null ? format : '$format/$abi';
}

class NativeBinaryException implements Exception {
  const NativeBinaryException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Inspects the header of [bytes]; throws [NativeBinaryException] when the bytes
/// cannot be a library for a supported platform.
NativeBinaryInfo inspectNativeBinary(Uint8List bytes) {
  if (bytes.length >= 20 && bytes[0] == 0x7f && bytes[1] == 0x45 && bytes[2] == 0x4c && bytes[3] == 0x46) {
    // ELF: e_machine is a 16-bit little-endian field at offset 18.
    final machine = bytes[18] | (bytes[19] << 8);
    return NativeBinaryInfo(format: 'elf', abi: _elfAbi(machine));
  }
  if (bytes.length >= 64 && bytes[0] == 0x4d && bytes[1] == 0x5a) {
    final peOffset =
        bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16) | (bytes[0x3f] << 24);
    if (peOffset > 0 && peOffset + 6 <= bytes.length) {
      final signatureOk =
          bytes[peOffset] == 0x50 &&
          bytes[peOffset + 1] == 0x45 &&
          bytes[peOffset + 2] == 0 &&
          bytes[peOffset + 3] == 0;
      if (signatureOk) {
        final machine = bytes[peOffset + 4] | (bytes[peOffset + 5] << 8);
        return NativeBinaryInfo(format: 'pe', abi: _peAbi(machine));
      }
    }
    throw const NativeBinaryException(
      'File starts with "MZ" but has no PE header; it is an old DOS executable, not a DLL',
    );
  }
  throw const NativeBinaryException(
    'Not a shared library: expected an ELF (.so) or PE (.dll) header',
  );
}

String? _elfAbi(int machine) {
  switch (machine) {
    case 0x28: // EM_ARM
      return 'arm';
    case 0x03: // EM_386
      return 'x86';
    case 0xb7: // EM_AARCH64
      return 'arm64';
    case 0x3e: // EM_X86_64
      return 'x64';
    default:
      return null;
  }
}

String? _peAbi(int machine) {
  switch (machine) {
    case 0x8664:
      return 'x64';
    case 0x014c:
      return 'x86';
    case 0xaa64:
      return 'arm64';
    default:
      return null;
  }
}

/// Cache key for an extracted library.
///
/// The archive's modification time plus the entry's position and length is
/// enough to tell "same bytes as last time" from "rebuilt since": a rebuild
/// writes a new archive file. Comparing only the size is not enough — two
/// builds of the same library often have identical sizes but different symbols.
String nativeCacheMarker({
  required int offset,
  required int size,
  required int archiveModifiedMs,
}) => '$offset:$size:$archiveModifiedMs';

/// Adds the "what to do about it" half to a raw loader message.
String describeLoadFailure(String raw, {required String abi}) {
  final lower = raw.toLowerCase();
  if (lower.contains('program alignment')) {
    return '$raw\n'
        '(the library was built for 4 KB pages; rebuild it with '
        '-Wl,-z,max-page-size=16384)';
  }
  if (lower.contains('needed by')) {
    return '$raw\n'
        '(a dependency is missing: load it first with nativeApi.load, or link it '
        'statically)';
  }
  if (lower.contains('not accessible for the namespace')) {
    return '$raw\n'
        '(load the library by absolute path from the app data directory)';
  }
  if (lower.contains('wrong elf class') || lower.contains('incompatible')) {
    return '$raw\n(this build runs $abi; rebuild the library for that ABI)';
  }
  return raw;
}
