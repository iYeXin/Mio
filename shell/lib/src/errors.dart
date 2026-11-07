/// The single error type the shell reports over JSON-RPC.
///
/// It lives in its own library so that Flutter-free modules (the process
/// manager, for example) can throw the same errors the bridge serialises,
/// without importing the widget-dependent API layer.
class MioApiException implements Exception {
  const MioApiException(this.code, this.message, [this.data]);

  final String code;
  final String message;
  final Object? data;

  @override
  String toString() => 'MioApiException($code): $message';
}
