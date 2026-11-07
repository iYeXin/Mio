/// Mio shell entry points:
///   flutter build apk     -t lib/main_android.dart
///   flutter build windows -t lib/main_windows.dart
///
/// The default entry point intentionally does not pick a platform because
/// Android and Windows use different WebView implementations.
void main() {
  throw UnsupportedError(
    'Use -t lib/main_android.dart or -t lib/main_windows.dart',
  );
}
