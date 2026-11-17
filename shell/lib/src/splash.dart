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

/// Full-window splash shown while the WebView loads.
///
/// Without an image it is just the configured background colour, which also
/// removes the white flash for dark apps.
class MioSplash extends StatelessWidget {
  const MioSplash({required this.manifest, this.image, super.key});

  final AppManifest manifest;
  final Uint8List? image;

  @override
  Widget build(BuildContext context) {
    final background = parseMioColor(
      manifest.splashBackground ?? manifest.backgroundColor,
      const Color(0xff0f1115),
    );
    final bytes = image;
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
