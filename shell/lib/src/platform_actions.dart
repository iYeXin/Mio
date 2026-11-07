import 'dart:ffi';

import 'package:ffi/ffi.dart';
import 'dart:io';

import 'package:flutter/services.dart';

/// Device-level controls that are not window geometry: keeping the screen on
/// and locking the orientation. Both are best-effort and platform specific.
abstract class PlatformActions {
  bool get supportsKeepAwake;
  bool get supportsOrientation;

  Future<void> keepAwake(bool enabled);
  Future<void> orientation(String mode);

  /// Desktop work area in logical-independent physical pixels, when the
  /// platform exposes it (Windows: SystemParametersInfo SPI_GETWORKAREA).
  Future<Map<String, Object?>?> workArea();
}

final class _Rect extends Struct {
  @Int32()
  external int left;
  @Int32()
  external int top;
  @Int32()
  external int right;
  @Int32()
  external int bottom;
}

PlatformActions createPlatformActions(String platformName) {
  if (platformName == 'android') return const AndroidPlatformActions();
  if (platformName == 'windows') return const WindowsPlatformActions();
  return const UnsupportedPlatformActions();
}

class AndroidPlatformActions implements PlatformActions {
  const AndroidPlatformActions();

  static const MethodChannel _channel = MethodChannel('mio/runtime');

  @override
  bool get supportsKeepAwake => true;

  @override
  bool get supportsOrientation => true;

  @override
  Future<void> keepAwake(bool enabled) =>
      _channel.invokeMethod<void>('setKeepScreenOn', {'enabled': enabled});

  @override
  Future<void> orientation(String mode) =>
      _channel.invokeMethod<void>('setOrientation', {'mode': mode});

  @override
  Future<Map<String, Object?>?> workArea() async => null;
}

/// `SetThreadExecutionState` keeps the display awake while the app is running.
class WindowsPlatformActions implements PlatformActions {
  const WindowsPlatformActions();

  static const int _esContinuous = 0x80000000;
  static const int _esSystemRequired = 0x00000001;
  static const int _esDisplayRequired = 0x00000002;

  static final DynamicLibrary _kernel32 = DynamicLibrary.open('kernel32.dll');
  static final DynamicLibrary _user32 = DynamicLibrary.open('user32.dll');
  static final int Function(int) _setThreadExecutionState = _kernel32
      .lookupFunction<Uint32 Function(Uint32), int Function(int)>(
        'SetThreadExecutionState',
      );

  @override
  bool get supportsKeepAwake => true;

  @override
  bool get supportsOrientation => false;

  static final int Function(int, int, Pointer<_Rect>, int) _getWorkArea = _user32
      .lookupFunction<Int32 Function(Uint32, Uint32, Pointer<_Rect>, Uint32),
          int Function(int, int, Pointer<_Rect>, int)>('SystemParametersInfoW');

  static const int _spiGetWorkArea = 0x0030;

  @override
  Future<Map<String, Object?>?> workArea() async {
    final rect = calloc<_Rect>();
    try {
      final ok = _getWorkArea(_spiGetWorkArea, 0, rect, 0);
      if (ok == 0) return null;
      return <String, Object?>{
        'x': rect.ref.left,
        'y': rect.ref.top,
        'width': rect.ref.right - rect.ref.left,
        'height': rect.ref.bottom - rect.ref.top,
      };
    } finally {
      calloc.free(rect);
    }
  }

  @override
  Future<void> keepAwake(bool enabled) async {
    final flags = enabled
        ? _esContinuous | _esSystemRequired | _esDisplayRequired
        : _esContinuous;
    // The call returns the previous state; 0 means it failed.
    if (_setThreadExecutionState(flags) == 0) {
      throw const OSError('SetThreadExecutionState failed');
    }
  }

  @override
  Future<void> orientation(String mode) =>
      Future.error(UnsupportedError('orientation is not supported on Windows'));
}

class UnsupportedPlatformActions implements PlatformActions {
  const UnsupportedPlatformActions();

  @override
  bool get supportsKeepAwake => false;

  @override
  bool get supportsOrientation => false;

  @override
  Future<void> keepAwake(bool enabled) =>
      Future.error(UnsupportedError('keepAwake is not supported on this platform'));

  @override
  Future<void> orientation(String mode) =>
      Future.error(UnsupportedError('orientation is not supported on this platform'));

  @override
  Future<Map<String, Object?>?> workArea() async => null;
}
