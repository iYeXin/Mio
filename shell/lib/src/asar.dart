import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// Minimal, read-only asar reader.
///
/// The on-disk format is the one used by @electron/asar:
///   8-byte prefix, header (Pickle containing a JSON string), then file data.
/// No unpacked entries or links are accepted; Mio packs a self-contained archive.
class AsarArchive {
  AsarArchive._(this._path, this._dataStart, this._root, this._size, this.modifiedMs);

  final String _path;
  final int _dataStart;
  final AsarNode _root;
  final int _size;

  /// Modification time of the archive file, in milliseconds.
  ///
  /// Together with an entry's offset and size it identifies the entry content
  /// well enough to cache extracted files without re-reading them.
  final int modifiedMs;

  static Future<AsarArchive> open(String path) async {
    final file = File(path);
    final total = await file.length();
    if (total < 16) {
      throw const AsarFormatException('asar is too small');
    }
    final modifiedMs = (await file.lastModified()).millisecondsSinceEpoch;

    final raf = await file.open();
    try {
      await raf.setPosition(0);
      final prefix = await raf.read(8);
      if (prefix.length != 8) {
        throw const AsarFormatException('cannot read asar prefix');
      }
      final headerSize = _readUint32(prefix, 4);
      if (headerSize <= 0 || headerSize > total - 8) {
        throw AsarFormatException('invalid asar header size: $headerSize');
      }

      await raf.setPosition(8);
      final header = await raf.read(headerSize);
      if (header.length != headerSize) {
        throw const AsarFormatException('truncated asar header');
      }

      // @electron/asar header layout:
      //   uint32 headerSize (repeated)
      //   uint32 jsonLength
      //   utf8 JSON
      //   padding to 4 bytes
      final jsonLength = _readUint32(header, 4);
      if (jsonLength <= 0 || jsonLength > headerSize - 8) {
        throw AsarFormatException('invalid asar JSON length: $jsonLength');
      }
      final jsonBytes = header.sublist(8, 8 + jsonLength);
      final decoded = jsonDecode(utf8.decode(jsonBytes));
      if (decoded is! Map<String, dynamic>) {
        throw const AsarFormatException('asar header is not an object');
      }

      final root = _parseNode('', decoded, total, 8 + headerSize);
      return AsarArchive._(path, 8 + headerSize, root, total, modifiedMs);
    } finally {
      await raf.close();
    }
  }

  int get size => _size;

  bool has(String path) => _lookup(path) != null;

  AsarNode? entry(String path) => _lookup(path);

  Future<Uint8List> read(String path) async {
    final node = _lookup(path);
    if (node == null) throw AsarNotFoundException(path);
    if (node.isDirectory) throw AsarFormatException('$path is a directory');
    final offset = node.offset!;
    final size = node.size!;
    if (offset < 0 || size < 0 || _dataStart + offset + size > _size) {
      throw AsarFormatException('file $path points outside archive');
    }
    if (size == 0) return Uint8List(0);

    final raf = await File(_path).open();
    try {
      await raf.setPosition(_dataStart + offset);
      return await raf.read(size);
    } finally {
      await raf.close();
    }
  }

  Future<String> readText(String path) async {
    return utf8.decode(await read(path));
  }

  /// Streams an entry without loading it into memory.
  ///
  /// Used for large files (native libraries, media) where reading the whole
  /// entry first would spike the heap.
  Stream<List<int>> readStream(String path) {
    final node = _entryForRead(path);
    final offset = node.offset!;
    final size = node.size!;
    if (size == 0) return const Stream<List<int>>.empty();
    return File(_path).openRead(_dataStart + offset, _dataStart + offset + size);
  }

  /// Byte offset and size of an entry, for cache keys and range reads.
  ({int offset, int size}) spanOf(String path) {
    final node = _entryForRead(path);
    return (offset: node.offset!, size: node.size!);
  }

  AsarNode _entryForRead(String path) {
    final node = _lookup(path);
    if (node == null) throw AsarNotFoundException(path);
    if (node.isDirectory) throw AsarFormatException('$path is a directory');
    final offset = node.offset!;
    final size = node.size!;
    if (offset < 0 || size < 0 || _dataStart + offset + size > _size) {
      throw AsarFormatException('file $path points outside archive');
    }
    return node;
  }

  Future<Map<String, dynamic>?> readJson(String path) async {
    if (!has(path)) return null;
    final value = jsonDecode(await readText(path));
    return value is Map<String, dynamic> ? value : null;
  }

  AsarNode? _lookup(String input) {
    var normalized = input.replaceAll('\\', '/');
    while (normalized.startsWith('/')) {
      normalized = normalized.substring(1);
    }
    if (normalized.isEmpty || normalized == '.') return _root;
    final segments = normalized.split('/');
    var current = _root;
    for (final segment in segments) {
      if (segment.isEmpty || segment == '.' || segment == '..') return null;
      final next = current.children[segment];
      if (next == null) return null;
      current = next;
    }
    return current;
  }

  static AsarNode _parseNode(
    String name,
    Map<String, dynamic> json,
    int archiveSize,
    int dataStart,
  ) {
    final files = json['files'];
    if (files is Map<String, dynamic>) {
      final children = <String, AsarNode>{};
      for (final entry in files.entries) {
        final value = entry.value;
        if (value is! Map<String, dynamic>) {
          throw AsarFormatException('invalid asar node: ${entry.key}');
        }
        children[entry.key] = _parseNode(entry.key, value, archiveSize, dataStart);
      }
      return AsarNode.directory(name, children);
    }

    if (json['unpacked'] == true) {
      throw AsarFormatException('unpacked asar entries are not supported: $name');
    }
    if (json['link'] != null) {
      throw AsarFormatException('asar links are not supported: $name');
    }

    final size = json['size'];
    final offset = json['offset'];
    if (size is! num || offset is! String) {
      throw AsarFormatException('invalid asar file entry: $name');
    }
    final parsedOffset = int.tryParse(offset);
    if (parsedOffset == null || parsedOffset < 0 || size < 0) {
      throw AsarFormatException('invalid asar offset/size: $name');
    }
    if (dataStart + parsedOffset + size > archiveSize) {
      throw AsarFormatException('asar entry $name extends beyond archive');
    }
    return AsarNode.file(name, parsedOffset, size.toInt());
  }

  static int _readUint32(Uint8List bytes, int offset) {
    return bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24);
  }
}

class AsarNode {
  AsarNode.directory(this.name, this.children)
      : offset = null,
        size = null,
        isDirectory = true;

  AsarNode.file(this.name, this.offset, this.size)
      : children = const {},
        isDirectory = false;

  final String name;
  final bool isDirectory;
  final Map<String, AsarNode> children;
  final int? offset;
  final int? size;
}

class AsarFormatException implements Exception {
  const AsarFormatException(this.message);
  final String message;

  @override
  String toString() => 'AsarFormatException: $message';
}

class AsarNotFoundException implements Exception {
  const AsarNotFoundException(this.path);
  final String path;

  @override
  String toString() => 'AsarNotFoundException: $path';
}
