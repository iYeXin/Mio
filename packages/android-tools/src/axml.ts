import { Buffer } from "node:buffer";

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;

export interface ManifestPatch {
  packageName: string;
  versionCode?: number;
  versionName?: string;
  appName?: string;
}

export interface AxmlAttribute {
  chunkOffset: number;
  attributeOffset: number;
  namespace: number;
  name: number;
  rawValue: number;
  valueType: number;
  data: number;
}

export interface AxmlElement {
  chunkOffset: number;
  name: string;
  attributes: AxmlAttribute[];
}

export interface AxmlDocument {
  strings: string[];
  elements: AxmlElement[];
  encoding: "utf8" | "utf16";
}

export function parseAxml(buffer: Buffer): AxmlDocument {
  const stringPool = findStringPool(buffer);
  const strings = decodeStringPool(buffer, stringPool);
  const encoding = (buffer.readUInt32LE(stringPool.offset + 16) & 0x100) !== 0 ? "utf8" : "utf16";
  const elements: AxmlElement[] = [];

  let offset = buffer.readUInt16LE(2);
  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > buffer.length) break;

    if (type === RES_XML_START_ELEMENT_TYPE) {
      const attrExt = offset + headerSize;
      const nameIndex = buffer.readUInt32LE(attrExt + 4);
      const attributeStart = buffer.readUInt16LE(attrExt + 8);
      const attributeSize = buffer.readUInt16LE(attrExt + 10);
      const attributeCount = buffer.readUInt16LE(attrExt + 12);
      const attributes: AxmlAttribute[] = [];
      let attributeOffset = attrExt + attributeStart;
      for (let index = 0; index < attributeCount; index += 1) {
        attributes.push({
          chunkOffset: offset,
          attributeOffset,
          namespace: buffer.readUInt32LE(attributeOffset),
          name: buffer.readUInt32LE(attributeOffset + 4),
          rawValue: buffer.readUInt32LE(attributeOffset + 8),
          valueType: buffer[attributeOffset + 15] ?? 0,
          data: buffer.readUInt32LE(attributeOffset + 16),
        });
        attributeOffset += attributeSize;
      }
      elements.push({
        chunkOffset: offset,
        name: strings[nameIndex] ?? "",
        attributes,
      });
    }

    offset += size;
  }

  return { strings, elements, encoding };
}

/**
 * Patch a binary AndroidManifest.xml.
 *
 * The template's MainActivity class is intentionally qualified with the
 * template package (dev.mio.mio_shell.MainActivity). The manifest package and
 * package-derived permission/authority strings are rewritten, but that class
 * name must remain untouched so Android can still resolve it.
 */
export function patchManifestAxml(buffer: Buffer, patch: ManifestPatch): Buffer {
  if (buffer.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new Error("not an Android binary XML document");
  }
  const document = parseAxml(buffer);
  const manifest = document.elements.find((element) => element.name === "manifest");
  if (!manifest) throw new Error("AndroidManifest.xml has no manifest element");
  const application = document.elements.find((element) => element.name === "application");

  const packageAttribute = findAttribute(document, manifest, "package");
  if (!packageAttribute) throw new Error("AndroidManifest.xml has no package attribute");
  const oldPackage = attributeString(document.strings, packageAttribute);
  if (!oldPackage) throw new Error("AndroidManifest.xml package is empty");

  const versionCodeAttribute = findAttribute(document, manifest, "versionCode");
  const versionNameAttribute = findAttribute(document, manifest, "versionName");
  const labelAttribute = application ? findAttribute(document, application, "label") : undefined;

  const activityClass = `${oldPackage}.MainActivity`;
  const strings = document.strings.map((value) => {
    if (value === activityClass) return value;
    if (value === oldPackage || value.startsWith(`${oldPackage}.`)) {
      return value.replace(oldPackage, patch.packageName);
    }
    return value;
  });

  let nextString = strings.length;
  if (patch.versionName !== undefined && versionNameAttribute) {
    const index = nextString++;
    strings.push(patch.versionName);
    setAttributeString(buffer, versionNameAttribute, index);
  }
  if (patch.appName !== undefined && labelAttribute) {
    const index = nextString++;
    strings.push(patch.appName);
    setAttributeString(buffer, labelAttribute, index);
  }
  if (patch.versionCode !== undefined && versionCodeAttribute) {
    buffer.writeUInt32LE(patch.versionCode >>> 0, versionCodeAttribute.attributeOffset + 16);
    buffer[versionCodeAttribute.attributeOffset + 15] = TYPE_INT_DEC;
  }

  return rebuildStringPool(buffer, strings);
}

function findAttribute(
  document: AxmlDocument,
  element: AxmlElement,
  name: string,
): AxmlAttribute | undefined {
  return element.attributes.find((attribute) => document.strings[attribute.name] === name);
}

function attributeString(strings: string[], attribute: AxmlAttribute): string | undefined {
  if (attribute.rawValue !== NO_INDEX && attribute.rawValue < strings.length) {
    return strings[attribute.rawValue];
  }
  if (attribute.valueType === TYPE_STRING && attribute.data < strings.length) {
    return strings[attribute.data];
  }
  return undefined;
}

function setAttributeString(buffer: Buffer, attribute: AxmlAttribute, index: number): void {
  buffer.writeUInt32LE(index, attribute.attributeOffset + 8);
  const typed = attribute.attributeOffset + 12;
  buffer.writeUInt16LE(8, typed);
  buffer[typed + 2] = 0;
  buffer[typed + 3] = TYPE_STRING;
  buffer.writeUInt32LE(index, typed + 4);
}

interface StringPoolInfo {
  offset: number;
  headerSize: number;
  size: number;
  stringCount: number;
  styleCount: number;
  flags: number;
  stringsStart: number;
  stylesStart: number;
}

function findStringPool(buffer: Buffer): StringPoolInfo {
  let offset = buffer.readUInt16LE(2);
  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const size = buffer.readUInt32LE(offset + 4);
    if (type === RES_STRING_POOL_TYPE) {
      const stringCount = buffer.readUInt32LE(offset + 8);
      const styleCount = buffer.readUInt32LE(offset + 12);
      const flags = buffer.readUInt32LE(offset + 16);
      const stringsStart = buffer.readUInt32LE(offset + 20);
      const stylesStart = buffer.readUInt32LE(offset + 24);
      if (styleCount !== 0) {
        throw new Error("AXML string pools with styles are not supported");
      }
      return { offset, headerSize, size, stringCount, styleCount, flags, stringsStart, stylesStart };
    }
    if (size < 8) break;
    offset += size;
  }
  throw new Error("AXML string pool not found");
}

function decodeStringPool(buffer: Buffer, pool: StringPoolInfo): string[] {
  const strings: string[] = [];
  const utf8 = (pool.flags & 0x100) !== 0;
  const table = pool.offset + pool.headerSize;
  const dataStart = pool.offset + pool.stringsStart;
  for (let index = 0; index < pool.stringCount; index += 1) {
    const relative = buffer.readUInt32LE(table + index * 4);
    let cursor = dataStart + relative;
    if (utf8) {
      const first = buffer.readUInt16LE(cursor);
      cursor += 2;
      if ((first & 0x8000) !== 0) {
        cursor += 2;
      }
      let byteLength = buffer.readUInt16LE(cursor);
      cursor += 2;
      if ((byteLength & 0x8000) !== 0) {
        byteLength = ((byteLength & 0x7fff) << 8) | buffer.readUInt16LE(cursor);
        cursor += 2;
      }
      strings.push(buffer.toString("utf8", cursor, cursor + byteLength));
    } else {
      const first = buffer.readUInt16LE(cursor);
      cursor += 2;
      let length = first;
      if ((first & 0x8000) !== 0) {
        length = ((first & 0x7fff) << 16) | buffer.readUInt16LE(cursor);
        cursor += 2;
      }
      strings.push(buffer.toString("utf16le", cursor, cursor + length * 2));
    }
  }
  return strings;
}

function rebuildStringPool(original: Buffer, newStrings: string[]): Buffer {
  const pool = findStringPool(original);
  const utf8 = (pool.flags & 0x100) !== 0;
  const encoded: Buffer[] = [];
  const offsets: number[] = [];
  let dataLength = 0;

  for (const value of newStrings) {
    offsets.push(dataLength);
    const item = encodeString(value, utf8);
    encoded.push(item);
    dataLength += item.length;
    const padding = (4 - (dataLength % 4)) % 4;
    if (padding > 0) {
      encoded.push(Buffer.alloc(padding));
      dataLength += padding;
    }
  }

  const tableLength = newStrings.length * 4;
  const chunkSize = 28 + tableLength + dataLength;
  const chunk = Buffer.alloc(chunkSize);
  chunk.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  chunk.writeUInt16LE(28, 2);
  chunk.writeUInt32LE(chunkSize, 4);
  chunk.writeUInt32LE(newStrings.length, 8);
  chunk.writeUInt32LE(0, 12);
  chunk.writeUInt32LE(pool.flags, 16);
  chunk.writeUInt32LE(28 + tableLength, 20);
  chunk.writeUInt32LE(0, 24);
  for (let index = 0; index < offsets.length; index += 1) {
    chunk.writeUInt32LE(offsets[index] ?? 0, 28 + index * 4);
  }
  let cursor = 28 + tableLength;
  for (const item of encoded) {
    item.copy(chunk, cursor);
    cursor += item.length;
  }

  const before = original.subarray(0, pool.offset);
  const after = original.subarray(pool.offset + pool.size);
  const result = Buffer.concat([before, chunk, after]);
  result.writeUInt32LE(result.length, 4);
  return result;
}

function encodeString(value: string, utf8: boolean): Buffer {
  if (utf8) {
    const bytes = Buffer.from(value, "utf8");
    const length = value.length;
    const lengthBytes = encodeUtf8Length(length);
    const byteLengthBytes = encodeUtf8Length(bytes.length);
    return Buffer.concat([lengthBytes, byteLengthBytes, bytes, Buffer.from([0])]);
  }
  const bytes = Buffer.from(value, "utf16le");
  const length = value.length;
  const lengthBytes = Buffer.alloc(length > 0x7fff ? 4 : 2);
  if (length > 0x7fff) {
    lengthBytes.writeUInt16LE(((length >> 16) & 0x7fff) | 0x8000, 0);
    lengthBytes.writeUInt16LE(length & 0xffff, 2);
  } else {
    lengthBytes.writeUInt16LE(length, 0);
  }
  return Buffer.concat([lengthBytes, bytes, Buffer.from([0, 0])]);
}

function encodeUtf8Length(length: number): Buffer {
  if (length > 0x7f) {
    return Buffer.from([((length >> 8) & 0x7f) | 0x80, length & 0xff]);
  }
  return Buffer.from([length]);
}
