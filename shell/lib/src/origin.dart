import 'dart:io';

/// The loopback origin an app is served from.
///
/// Scheme+host+port is the page origin; a random port would give every launch a
/// new origin, which wipes localStorage/IndexedDB and makes service workers
/// unreachable. Deriving the port from the app id keeps it stable for the life
/// of the installation, and different apps get different ports.
///
/// Port collisions are reported instead of falling back to another port: a
/// silent change would again reset the origin (and the app's storage).
typedef OriginTarget = ({String host, int port});

const int _portBase = 20000;
const int _portSpan = 30000;

OriginTarget originTargetFor(String appId) {
  final forcedHost = Platform.environment['MIO_ORIGIN_HOST'];
  final forcedPort = int.tryParse(Platform.environment['MIO_ORIGIN_PORT'] ?? '');
  if (forcedHost != null && forcedPort != null) {
    return (host: forcedHost, port: forcedPort);
  }

  // 127.0.0.1 rather than another 127/8 address: Android's cleartext policy
  // only permits that literal, and the page is loaded over http.
  var hash = 0x811c9dc5;
  for (final unit in appId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  final port = _portBase + ((hash >> 4) % _portSpan);
  return (host: '127.0.0.1', port: port);
}
