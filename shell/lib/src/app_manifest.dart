import 'dart:convert';

class AppManifest {
  const AppManifest({
    required this.id,
    required this.name,
    required this.version,
    required this.entry,
    this.width = 1024,
    this.height = 720,
    this.backgroundColor = '#ffffff',
    this.requiredApiVersion,
  });

  final String id;
  final String name;
  final String version;
  final String entry;
  final int width;
  final int height;
  final String backgroundColor;

  /// Minimum Mio API the app was built against, e.g. "1.0.0".
  final String? requiredApiVersion;

  String get title => name;

  static const fallback = AppManifest(
    id: 'dev.mio.unknown',
    name: 'Mio App',
    version: '0.0.0',
    entry: 'index.html',
  );

  factory AppManifest.fromJson(Map<String, dynamic> json) {
    final window = json['window'];
    final windowMap = window is Map<String, dynamic> ? window : const <String, dynamic>{};
    final requires = json['requires'];
    final requiresMap =
        requires is Map<String, dynamic> ? requires : const <String, dynamic>{};
    return AppManifest(
      id: _string(json['id'], fallback.id),
      name: _string(json['name'], fallback.name),
      version: _string(json['version'], fallback.version),
      entry: _normalizeEntry(_string(json['entry'], fallback.entry)),
      width: _positiveInt(windowMap['width'], fallback.width),
      height: _positiveInt(windowMap['height'], fallback.height),
      backgroundColor: _string(windowMap['backgroundColor'], fallback.backgroundColor),
      requiredApiVersion:
          requiresMap['apiVersion'] is String ? requiresMap['apiVersion'] as String : null,
    );
  }

  static AppManifest parse(String source) {
    final value = jsonDecode(source);
    if (value is! Map<String, dynamic>) {
      throw const FormatException('mio-manifest.json must be an object');
    }
    return AppManifest.fromJson(value);
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'version': version,
        'entry': entry,
        'window': {
          'width': width,
          'height': height,
          'backgroundColor': backgroundColor,
        },
        if (requiredApiVersion != null)
          'requires': {'apiVersion': requiredApiVersion},
      };

  static String _string(Object? value, String fallback) {
    return value is String && value.trim().isNotEmpty ? value.trim() : fallback;
  }

  static int _positiveInt(Object? value, int fallback) {
    if (value is int && value > 0) return value;
    if (value is num && value > 0) return value.toInt();
    return fallback;
  }

  static String _normalizeEntry(String entry) {
    var value = entry.replaceAll('\\', '/');
    while (value.startsWith('/')) {
      value = value.substring(1);
    }
    return value.isEmpty ? 'index.html' : value;
  }
}
