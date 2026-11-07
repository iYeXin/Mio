import 'dart:io';

/// Writes [source] into [target] through a sibling `.part` file.
///
/// A crash, a full disk or a dropped HTTP upload in the middle of a write would
/// otherwise leave a truncated file that later looks valid to `exists` /
/// `stat` / `read`. The rename is the only step that makes the new content
/// visible.
Future<void> atomicWriteStream(File target, Stream<List<int>> source) async {
  await target.parent.create(recursive: true);
  final temporary = File('${target.path}.part');
  final sink = temporary.openWrite();
  try {
    await sink.addStream(source);
    await sink.close();
  } on Object {
    await _discard(sink, temporary);
    rethrow;
  }
  try {
    if (await target.exists()) await target.delete();
    await temporary.rename(target.path);
  } on Object {
    try {
      if (await temporary.exists()) await temporary.delete();
    } on Object {
      // Best effort; a leftover .part is harmless.
    }
    rethrow;
  }
}

/// Convenience wrapper for in-memory payloads.
Future<void> atomicWriteBytes(File target, List<int> bytes) {
  return atomicWriteStream(target, Stream<List<int>>.value(bytes));
}

Future<void> _discard(IOSink sink, File temporary) async {
  try {
    await sink.close();
  } on Object {
    // The sink may already be closed.
  }
  try {
    if (await temporary.exists()) await temporary.delete();
  } on Object {
    // Best effort; a leftover .part is harmless.
  }
}
