import 'package:flutter_test/flutter_test.dart';
import 'package:mio_shell/src/origin.dart';

void main() {
  test("origin is stable for an app id", () {
    final first = originTargetFor("dev.mio.notes");
    final second = originTargetFor("dev.mio.notes");
    expect(first.host, "127.0.0.1");
    expect(first.port, second.port);
    expect(first.port, inInclusiveRange(20000, 49999));
  });

  test("different apps get different ports", () {
    final ports = {
      for (final id in [
        "dev.mio.notes",
        "dev.mio.minefield",
        "com.example.hello",
        "dev.mio.platformcheck",
      ])
        originTargetFor(id).port,
    };
    expect(ports.length, 4);
  });
}