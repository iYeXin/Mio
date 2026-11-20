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
    this.theme = 'system',
    this.splash = const <String, String>{},
    this.splashBackground = const <String, String>{},
    this.splashFit = 'contain',
    this.statusBar = 'visible',
    this.orientation = 'auto',
    this.requiredApiVersion,
    this.foregroundService = false,
    this.x,
    this.y,
    this.center = true,
    this.resizable = true,
    this.decorations = true,
    this.alwaysOnTop = false,
    this.minWidth,
    this.minHeight,
    this.windowTitle,
    this.devTools,
  });

  final String id;
  final String name;
  final String version;
  final String entry;
  final int width;
  final int height;
  final String backgroundColor;

  /// Startup appearance: `system`, `light` or `dark`.
  ///
  /// The shell resolves it before the page runs, so the splash and the status
  /// bar icons match the theme the app asked for.
  final String theme;

  /// Splash image inside the app archive per brightness (`light` / `dark`).
  final Map<String, String> splash;
  /// Background behind the splash per brightness; falls back to
  /// [backgroundColor].
  final Map<String, String> splashBackground;
  /// `contain` or `cover`.
  final String splashFit;

  /// Startup status bar behaviour: `visible`, `hidden` or `immersive`.
  final String statusBar;

  /// Startup rotation lock: `auto`, `portrait` or `landscape`.
  final String orientation;

  /// Splash path for the given brightness; a single variant covers both.
  String? splashPath({required bool dark}) {
    final wanted = dark ? 'dark' : 'light';
    return splash[wanted] ?? splash['light'] ?? splash['dark'];
  }

  /// Splash background for the given brightness, or null when none is set.
  String? splashBackgroundFor({required bool dark}) {
    final wanted = dark ? 'dark' : 'light';
    return splashBackground[wanted] ??
        splashBackground['light'] ??
        splashBackground['dark'];
  }

  /// Minimum Mio API the app was built against, e.g. "1.0.0".
  final String? requiredApiVersion;

  /// Whether the app declared `android.foregroundService` in mio.config.json.
  final bool foregroundService;

  /// Initial window position, or null for the platform default.
  final int? x;
  final int? y;
  final bool center;
  final bool resizable;
  final bool decorations;
  final bool alwaysOnTop;
  final int? minWidth;
  final int? minHeight;

  /// `window.title` from the config; falls back to [name].
  final String? windowTitle;

  /// Explicit `devtools` setting; null means "dev mode only".
  final bool? devTools;

  String get title => (windowTitle != null && windowTitle!.trim().isNotEmpty)
      ? windowTitle!.trim()
      : name;

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
    final android = json['android'];
    final androidMap =
        android is Map<String, dynamic> ? android : const <String, dynamic>{};
    return AppManifest(
      id: _string(json['id'], fallback.id),
      name: _string(json['name'], fallback.name),
      version: _string(json['version'], fallback.version),
      entry: _normalizeEntry(_string(json['entry'], fallback.entry)),
      width: _positiveInt(windowMap['width'], fallback.width),
      height: _positiveInt(windowMap['height'], fallback.height),
      backgroundColor: _string(windowMap['backgroundColor'], fallback.backgroundColor),
      theme: _theme(windowMap['theme']),
      splash: _themedStrings(windowMap['splash']),
      splashBackground: _themedStrings(windowMap['splashBackground']),
      splashFit: windowMap['splashFit'] == 'cover' ? 'cover' : 'contain',
      statusBar: _statusBar(androidMap['statusBar']),
      orientation: _orientation(androidMap['orientation']),
      requiredApiVersion:
          requiresMap['apiVersion'] is String ? requiresMap['apiVersion'] as String : null,
      foregroundService: androidMap['foregroundService'] == true,
      x: _optionalInt(windowMap['x']),
      y: _optionalInt(windowMap['y']),
      center: windowMap['center'] != false,
      resizable: windowMap['resizable'] != false,
      decorations: windowMap['decorations'] != false,
      alwaysOnTop: windowMap['alwaysOnTop'] == true,
      minWidth: _optionalInt(windowMap['minWidth']),
      minHeight: _optionalInt(windowMap['minHeight']),
      windowTitle: windowMap['title'] is String ? windowMap['title'] as String : null,
      devTools: json['devtools'] is bool ? json['devtools'] as bool : null,
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
          'theme': theme,
          if (splash.isNotEmpty) 'splash': splash,
          if (splashBackground.isNotEmpty) 'splashBackground': splashBackground,
          if (splash.isNotEmpty) 'splashFit': splashFit,
        },
        if (requiredApiVersion != null)
          'requires': {'apiVersion': requiredApiVersion},
        if (foregroundService || statusBar != 'visible' || orientation != 'auto')
          'android': {
            if (foregroundService) 'foregroundService': true,
            if (statusBar != 'visible') 'statusBar': statusBar,
            if (orientation != 'auto') 'orientation': orientation,
          },
      };

  static const Set<String> _barModes = {'visible', 'hidden', 'immersive'};
  static const Set<String> _orientations = {'auto', 'portrait', 'landscape'};

  static String _theme(Object? value) {
    return value == 'light' || value == 'dark' ? value! as String : 'system';
  }

  static String _statusBar(Object? value) {
    return value is String && _barModes.contains(value) ? value : 'visible';
  }

  static String _orientation(Object? value) {
    return value is String && _orientations.contains(value) ? value : 'auto';
  }

  /// Accepts `"x.png"` (both brightnesses) and `{ light, dark }`.
  static Map<String, String> _themedStrings(Object? value) {
    final out = <String, String>{};
    void add(String key, Object? entry) {
      if (entry is String && entry.trim().isNotEmpty) out[key] = entry.trim();
    }

    if (value is Map) {
      add('light', value['light']);
      add('dark', value['dark']);
    } else {
      add('light', value);
      add('dark', value);
    }
    return out;
  }

  static String _string(Object? value, String fallback) {
    return value is String && value.trim().isNotEmpty ? value.trim() : fallback;
  }

  static int? _optionalInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return null;
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
