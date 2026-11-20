import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'app_manifest.dart';

/// Parses `#rgb`, `#rrggbb` and `#aarrggbb`; falls back to [fallback].
Color parseMioColor(String? value, Color fallback) {
  final text = value?.trim();
  if (text == null || !text.startsWith('#')) return fallback;
  var hex = text.substring(1);
  if (hex.length == 3) {
    hex = hex.split('').map((char) => '$char$char').join();
  }
  if (hex.length != 6 && hex.length != 8) return fallback;
  final parsed = int.tryParse(hex, radix: 16);
  if (parsed == null) return fallback;
  return Color(hex.length == 6 ? 0xff000000 | parsed : parsed);
}

/// Brightness the shell and the page should treat as the startup theme.
///
/// `window.theme` wins: the app declared what it will render, so the shell must
/// not guess from the system setting. `system` follows [platform].
Brightness mioStartupBrightness(String theme, Brightness platform) {
  if (theme == 'light') return Brightness.light;
  if (theme == 'dark') return Brightness.dark;
  return platform;
}

/// Full-window splash shown while the WebView loads.
///
/// Both brightnesses can be configured, because the page has not run yet and
/// cannot pick the image itself. Without an image it is just the configured
/// background colour, which also removes the white flash for dark apps.
class MioSplash extends StatelessWidget {
  const MioSplash({
    required this.manifest,
    this.imageLight,
    this.imageDark,
    super.key,
  });

  final AppManifest manifest;
  final Uint8List? imageLight;
  final Uint8List? imageDark;

  @override
  Widget build(BuildContext context) {
    final platform =
        MediaQuery.maybeOf(context)?.platformBrightness ?? Brightness.light;
    final dark = mioStartupBrightness(manifest.theme, platform) == Brightness.dark;
    final fallback = parseMioColor(manifest.backgroundColor, const Color(0xff0f1115));
    final background = parseMioColor(
      manifest.splashBackgroundFor(dark: dark),
      fallback,
    );
    final bytes = dark ? (imageDark ?? imageLight) : (imageLight ?? imageDark);
    return ColoredBox(
      color: background,
      child: bytes == null
          ? const SizedBox.expand()
          : SizedBox.expand(
              child: Image.memory(
                bytes,
                fit: manifest.splashFit == 'cover' ? BoxFit.cover : BoxFit.contain,
                alignment: Alignment.center,
                gaplessPlayback: true,
                filterQuality: FilterQuality.medium,
              ),
            ),
    );
  }
}
