import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'app_manifest.dart';
import 'runtime.dart';
import 'window_actions.dart';
import 'window_actions_windows.dart';

class MioPlatformWindows implements MioPlatform {
  @override
  String get name => 'windows';

  @override
  Future<String?> getDevUrl() async {
    final value = Platform.environment['MIO_DEV_URL'];
    return value == null || value.isEmpty ? null : value;
  }

  @override
  Future<AppManifest?> getDevManifest() async {
    final name = Platform.environment['MIO_DEV_APP_NAME'];
    if (name == null || name.isEmpty) return null;
    final width = int.tryParse(Platform.environment['MIO_DEV_WINDOW_WIDTH'] ?? '');
    final height = int.tryParse(Platform.environment['MIO_DEV_WINDOW_HEIGHT'] ?? '');
    return AppManifest(
      id: Platform.environment['MIO_DEV_APP_ID'] ?? AppManifest.fallback.id,
      name: name,
      version: Platform.environment['MIO_DEV_APP_VERSION'] ?? AppManifest.fallback.version,
      entry: 'index.html',
      width: width != null && width > 0 ? width : 1024,
      height: height != null && height > 0 ? height : 720,
    );
  }

  @override
  Future<String> prepareAsar() async {
    final support = await getApplicationSupportDirectory();
    final directory = Directory(p.join(support.path, 'mio'));
    await directory.create(recursive: true);
    final destination = p.join(directory.path, 'app.asar');

    final override = Platform.environment['MIO_ASAR_PATH'];
    if (override != null && override.isNotEmpty) {
      final source = File(override);
      if (await source.exists()) {
        await source.copy(destination);
        return destination;
      }
    }

    final sidecar = File(p.join(
      p.dirname(Platform.resolvedExecutable),
      'data',
      'mio',
      'app.asar',
    ));
    if (await sidecar.exists()) {
      await sidecar.copy(destination);
      return destination;
    }

    final bytes = _readResource('MIO_ASAR');
    if (bytes == null || bytes.isEmpty) {
      throw StateError('The injected MIO_ASAR resource is missing from the executable');
    }
    await File(destination).writeAsBytes(bytes, flush: true);
    return destination;
  }

  @override
  WindowActions createWindowActions() => WindowActionsWindows();

  @override
  Future<void> prepareWindow(AppManifest manifest) async {}
}

typedef _GetModuleHandleWNative = IntPtr Function(Pointer<Utf16>);
typedef _GetModuleHandleWDart = int Function(Pointer<Utf16>);
typedef _FindResourceWNative = IntPtr Function(IntPtr, Pointer<Utf16>, Pointer<Utf16>);
typedef _FindResourceWDart = int Function(int, Pointer<Utf16>, Pointer<Utf16>);
typedef _LoadResourceNative = IntPtr Function(IntPtr, IntPtr);
typedef _LoadResourceDart = int Function(int, int);
typedef _LockResourceNative = Pointer<Uint8> Function(IntPtr);
typedef _LockResourceDart = Pointer<Uint8> Function(int);
typedef _SizeofResourceNative = Uint32 Function(IntPtr, IntPtr);
typedef _SizeofResourceDart = int Function(int, int);

Uint8List? _readResource(String name) {
  if (!Platform.isWindows) return null;
  final kernel32 = DynamicLibrary.open('kernel32.dll');
  final getModuleHandle = kernel32.lookupFunction<_GetModuleHandleWNative, _GetModuleHandleWDart>(
    'GetModuleHandleW',
  );
  final findResource = kernel32.lookupFunction<_FindResourceWNative, _FindResourceWDart>(
    'FindResourceW',
  );
  final loadResource = kernel32.lookupFunction<_LoadResourceNative, _LoadResourceDart>(
    'LoadResource',
  );
  final lockResource = kernel32.lookupFunction<_LockResourceNative, _LockResourceDart>(
    'LockResource',
  );
  final sizeOfResource = kernel32.lookupFunction<_SizeofResourceNative, _SizeofResourceDart>(
    'SizeofResource',
  );

  final module = getModuleHandle(nullptr);
  if (module == 0) return null;

  final nativeName = name.toNativeUtf16();
  // RT_RCDATA is MAKEINTRESOURCE(10).
  final type = Pointer<Utf16>.fromAddress(10);
  try {
    final resource = findResource(module, nativeName, type);
    if (resource == 0) return null;
    final loaded = loadResource(module, resource);
    if (loaded == 0) return null;
    final size = sizeOfResource(module, resource);
    if (size <= 0) return null;
    final pointer = lockResource(loaded);
    if (pointer == nullptr) return null;
    return Uint8List.fromList(pointer.asTypedList(size));
  } finally {
    malloc.free(nativeName);
  }
}
