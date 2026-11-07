/// Parsing for HTTP `Range` headers on the blob endpoint.
///
/// Kept as a pure function so it can be unit tested without an HTTP server.
/// Only the single-range form is supported: `bytes=start-end`, `bytes=start-`
/// and `bytes=-suffix`. Multi-range requests fall back to a full response,
/// which is allowed by RFC 7233 ("a server MAY ignore the Range header").
library;

import 'dart:math' as math;

/// Returns inclusive `(start, end)`, or `null` when the header is absent,
/// malformed, or unsatisfiable.
({int start, int end})? parseByteRange(String? header, int length) {
  if (header == null || length <= 0) return null;
  final value = header.trim();
  if (value.length < 7 || !value.toLowerCase().startsWith('bytes=')) {
    return null;
  }

  final spec = value.substring(6).split(',').first.trim();
  final dash = spec.indexOf('-');
  if (dash < 0) return null;

  final startText = spec.substring(0, dash).trim();
  final endText = spec.substring(dash + 1).trim();

  if (startText.isEmpty) {
    // Suffix range: the last N bytes.
    final suffix = int.tryParse(endText);
    if (suffix == null || suffix <= 0) return null;
    final start = math.max(0, length - suffix);
    return (start: start, end: length - 1);
  }

  final start = int.tryParse(startText);
  if (start == null || start < 0 || start >= length) return null;

  final end = endText.isEmpty ? length - 1 : int.tryParse(endText);
  if (end == null || end < start) return null;

  return (start: start, end: math.min(end, length - 1));
}
