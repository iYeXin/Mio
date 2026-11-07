import 'dart:ffi';
import 'dart:io';

import 'package:flutter/services.dart';

/// Device-level controls that are not window geometry: keeping the screen on
/// and locking the orientation. Both are best-effort and platform specific.
abstract class PlatformActions {
  bool get supportsKeepAwake;
  bool get supportsOrientation;

  Future<void> keepAwake(bool enabled);
  Future<void> orientation(String mode);
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
}

/// `SetThreadExecutionState` keeps the display awake while the app is running.
class WindowsPlatformActions implements PlatformActions {
  const WindowsPlatformActions();

  static const int _esContinuous = 0x80000000;
  static const int _esSystemRequired = 0x00000001;
  static const int _esDisplayRequired = 0x00000002;

  static final DynamicLibrary _kernel32 = DynamicLibrary.open('kernel32.dll');
  static final int Function(int) _setThreadExecutionState = _kernel32
      .lookupFunction<Uint32 Function(Uint32), int Function(int)>(
        'SetThreadExecutionState',
      );

  @override
  bool get supportsKeepAwake => true;

  @override
  bool get supportsOrientation => false;

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
}
