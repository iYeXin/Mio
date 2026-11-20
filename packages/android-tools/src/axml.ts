import { Buffer } from "node:buffer";

// Binary XML (AXML) as used by AndroidManifest.xml.
//
// The old implementation rewrote the string pool in place, so it could only
// change existing strings and numbers. Decoding to a model and encoding it back
// keeps every element, attribute and resource ID, and lets later work add
// permissions or meta-data without a second binary editor.
//
// The format is stable (chunked, little endian):
//
//   XML header
//   string pool
//   resource map        attribute name string index -> framework/app resource ID
//   start namespace ... elements ... end namespace
//
// The resource map is what makes attributes work: Android resolves
// `android:versionCode` through the ID stored there, not through the name.

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;

const NODE_HEADER_SIZE = 16;
const ELEMENT_HEADER_SIZE = 36;
const ATTRIBUTE_SIZE = 20;
const STRING_POOL_HEADER_SIZE = 28;

export interface ManifestPatch {
  packageName: string;
  versionCode?: number;
  versionName?: string;
  appName?: string;
}

/** A typed attribute value: `data` is a string index for strings, else a number. */
export interface AxmlValue {
  type: number;
  data: number | string;
}

export interface AxmlAttribute {
  /** Namespace URI, or null for attributes without one (e.g. `package`). */
  namespace: string | null;
  name: string;
  /** Framework/app attribute ID recovered from the resource map; 0 when none. */
  resourceId: number;
  /** Raw text, when the encoder kept one; null for numeric values. */
  rawValue: string | null;
  value: AxmlValue;
}

export interface AxmlElement {
  namespace: string | null;
  name: string;
  line: number;
  endLine: number;
  attributes: AxmlAttribute[];
  children: AxmlElement[];
}

export interface AxmlNamespace {
  prefix: string;
  uri: string;
  line: number;
}

export interface AxmlDocument {
  namespaces: AxmlNamespace[];
  root: AxmlElement;
  /** Attribute name -> resource ID, recovered from the resource map. */
  resourceIds: Map<string, number>;
}

interface StringPool {
  strings: string[];
}

export function decodeAxml(buffer: Buffer): AxmlDocument {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== RES_XML_TYPE) {
    throw new Error("not an Android binary XML document");
  }

  let strings: string[] = [];
  const resourceIds = new Map<string, number>();
  const namespaces: AxmlNamespace[] = [];
  const stack: AxmlElement[] = [];
  let root: AxmlElement | undefined;

  let offset = buffer.readUInt16LE(2);
  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const size = buffer.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > buffer.length || headerSize < 8) {
      throw new Error(`AXML chunk at ${offset} is truncated or malformed`);
    }
    const line = headerSize >= NODE_HEADER_SIZE ? buffer.readUInt32LE(offset + 8) : 0;

    switch (type) {
      case RES_STRING_POOL_TYPE: {
        strings = decodeStringPool(buffer, offset).strings;
        break;
      }
      case RES_XML_RESOURCE_MAP_TYPE: {
        const count = (size - 8) / 4;
        for (let index = 0; index < count; index += 1) {
          const id = buffer.readUInt32LE(offset + 8 + index * 4);
          const name = strings[index];
          if (id !== 0 && name !== undefined) resourceIds.set(name, id);
        }
        break;
      }
      case RES_XML_START_NAMESPACE_TYPE: {
        const ext = offset + headerSize;
        namespaces.push({
          prefix: stringAt(strings, buffer.readUInt32LE(ext)),
          uri: stringAt(strings, buffer.readUInt32LE(ext + 4)),
          line,
        });
        break;
      }
      case RES_XML_START_ELEMENT_TYPE: {
        const element = decodeElement(buffer, offset, headerSize, strings, resourceIds);
        if (stack.length > 0) {
          stack[stack.length - 1]!.children.push(element);
        } else if (root === undefined) {
          root = element;
        } else {
          throw new Error("AXML has more than one root element");
        }
        stack.push(element);
        break;
      }
      case RES_XML_END_ELEMENT_TYPE: {
        const ext = offset + headerSize;
        const name = stringAt(strings, buffer.readUInt32LE(ext + 4));
        const current = stack.pop();
        if (current === undefined || current.name !== name) {
          throw new Error(`AXML end element </${name}> does not match <${current?.name ?? "?"}>`);
        }
        current.endLine = line;
        break;
      }
      case RES_XML_CDATA_TYPE:
        throw new Error("AXML CDATA sections are not supported in a manifest");
      case RES_XML_END_NAMESPACE_TYPE:
        break;
      default:
        break;
    }

    offset += size;
  }

  if (root === undefined) throw new Error("AXML has no root element");
  if (stack.length > 0) {
    throw new Error(`AXML ends inside <${stack[stack.length - 1]!.name}>`);
  }
  return { namespaces, root, resourceIds };
}

function decodeElement(
  buffer: Buffer,
  offset: number,
  headerSize: number,
  strings: string[],
  resourceIds: Map<string, number>,
): AxmlElement {
  const ext = offset + headerSize;
  const namespace = namespaceAt(strings, buffer.readUInt32LE(ext));
  const name = stringAt(strings, buffer.readUInt32LE(ext + 4));
  const attributeStart = buffer.readUInt16LE(ext + 8);
  const attributeSize = buffer.readUInt16LE(ext + 10);
  const attributeCount = buffer.readUInt16LE(ext + 12);
  if (attributeSize < ATTRIBUTE_SIZE) {
    throw new Error(`AXML attribute size ${attributeSize} is too small`);
  }

  const attributes: AxmlAttribute[] = [];
  for (let index = 0; index < attributeCount; index += 1) {
    const at = ext + attributeStart + index * attributeSize;
    if (at + ATTRIBUTE_SIZE > offset + buffer.readUInt32LE(offset + 4)) {
      throw new Error("AXML attribute runs past its element chunk");
    }
    const attributeNamespace = namespaceAt(strings, buffer.readUInt32LE(at));
    const attributeName = stringAt(strings, buffer.readUInt32LE(at + 4));
    const rawIndex = buffer.readUInt32LE(at + 8);
    const dataType = buffer[at + 15] ?? 0;
    const data = buffer.readUInt32LE(at + 16);
    attributes.push({
      namespace: attributeNamespace,
      name: attributeName,
      resourceId: resourceIds.get(attributeName) ?? 0,
      rawValue: rawIndex === NO_INDEX ? null : stringAt(strings, rawIndex),
      value: {
        type: dataType,
        data: dataType === TYPE_STRING ? stringAt(strings, data) : data,
      },
    });
  }

  return { namespace, name, line: buffer.readUInt32LE(offset + 8), endLine: 0, attributes, children: [] };
}

function decodeStringPool(buffer: Buffer, offset: number): StringPool {
  const headerSize = buffer.readUInt16LE(offset + 2);
  const stringCount = buffer.readUInt32LE(offset + 8);
  const styleCount = buffer.readUInt32LE(offset + 12);
  const flags = buffer.readUInt32LE(offset + 16);
  const stringsStart = buffer.readUInt32LE(offset + 20);
  if (styleCount !== 0) {
    throw new Error("AXML string pools with styles are not supported");
  }
  const utf8 = (flags & 0x100) !== 0;
  const table = offset + headerSize;
  const dataStart = offset + stringsStart;
  const strings: string[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    let cursor = dataStart + buffer.readUInt32LE(table + index * 4);
    if (utf8) {
      const first = buffer.readUInt16LE(cursor);
      cursor += 2;
      let byteLength = first;
      if ((first & 0x8000) !== 0) {
        byteLength = ((first & 0x7fff) << 8) | buffer.readUInt16LE(cursor);
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
  return { strings };
}

function stringAt(strings: string[], index: number): string {
  return index === NO_INDEX ? "" : strings[index] ?? "";
}

function namespaceAt(strings: string[], index: number): string | null {
  return index === NO_INDEX ? null : strings[index] ?? null;
}

/** Serializes a decoded document back to binary XML. */
export function encodeAxml(document: AxmlDocument): Buffer {
  const strings = new StringWriter();
  const attributeNames = collectAttributeNames(document);
  for (const name of attributeNames) strings.index(name);

  const namespaceChunks: Buffer[] = [];
  for (const namespace of document.namespaces) {
    strings.index(namespace.prefix);
    strings.index(namespace.uri);
    namespaceChunks.push(
      namespaceChunk(RES_XML_START_NAMESPACE_TYPE, strings.index(namespace.prefix), strings.index(namespace.uri), namespace.line),
    );
  }
  const endNamespaceChunks = [...document.namespaces]
    .reverse()
    .map((namespace) =>
      namespaceChunk(
        RES_XML_END_NAMESPACE_TYPE,
        strings.index(namespace.prefix),
        strings.index(namespace.uri),
        namespace.line,
      ),
    );

  collectElementStrings(document.root, strings);

  const pool = stringPoolChunk(strings.values);
  const resourceMap = resourceMapChunk(attributeNames, document);
  const elements = encodeElement(document.root, strings);
  const chunks = [pool, resourceMap, ...namespaceChunks, ...elements, ...endNamespaceChunks];
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

class StringWriter {
  private readonly indices = new Map<string, number>();
  readonly values: string[] = [];

  index(value: string): number {
    const existing = this.indices.get(value);
    if (existing !== undefined) return existing;
    const next = this.values.length;
    this.values.push(value);
    this.indices.set(value, next);
    return next;
  }
}

/**
 * Attribute name strings first: the resource map is indexed by string index, so
 * every name that carries an ID must sit in the first block.
 */
function collectAttributeNames(document: AxmlDocument): string[] {
  const withId: string[] = [];
  const withoutId: string[] = [];
  const seen = new Set<string>();
  for (const element of walk(document.root)) {
    for (const attribute of element.attributes) {
      if (seen.has(attribute.name)) continue;
      seen.add(attribute.name);
      (attribute.resourceId ? withId : withoutId).push(attribute.name);
    }
  }
  return [...withId, ...withoutId];
}

function collectElementStrings(element: AxmlElement, strings: StringWriter): void {
  strings.index(element.name);
  if (element.namespace !== null) strings.index(element.namespace);
  for (const attribute of element.attributes) {
    strings.index(attribute.name);
    if (attribute.namespace !== null) strings.index(attribute.namespace);
    if (attribute.rawValue !== null) strings.index(attribute.rawValue);
    if (typeof attribute.value.data === "string") strings.index(attribute.value.data);
  }
  for (const child of element.children) collectElementStrings(child, strings);
}

function encodeElement(element: AxmlElement, strings: StringWriter): Buffer[] {
  const attributes = element.attributes.map((attribute) => {
    const buffer = Buffer.alloc(ATTRIBUTE_SIZE);
    buffer.writeUInt32LE(attribute.namespace === null ? NO_INDEX : strings.index(attribute.namespace), 0);
    buffer.writeUInt32LE(strings.index(attribute.name), 4);
    buffer.writeUInt32LE(attribute.rawValue === null ? NO_INDEX : strings.index(attribute.rawValue), 8);
    buffer.writeUInt16LE(8, 12);
    buffer[15] = attribute.value.type;
    const data = attribute.value.data;
    buffer.writeUInt32LE(typeof data === "string" ? strings.index(data) : data >>> 0, 16);
    return buffer;
  });

  const header = Buffer.alloc(ELEMENT_HEADER_SIZE);
  header.writeUInt16LE(RES_XML_START_ELEMENT_TYPE, 0);
  header.writeUInt16LE(NODE_HEADER_SIZE, 2);
  header.writeUInt32LE(ELEMENT_HEADER_SIZE + attributes.length * ATTRIBUTE_SIZE, 4);
  header.writeUInt32LE(element.line, 8);
  header.writeUInt32LE(NO_INDEX, 12);
  header.writeUInt32LE(element.namespace === null ? NO_INDEX : strings.index(element.namespace), 16);
  header.writeUInt32LE(strings.index(element.name), 20);
  header.writeUInt16LE(20, 24); // attributeStart, relative to the element extension
  header.writeUInt16LE(ATTRIBUTE_SIZE, 26);
  header.writeUInt16LE(attributes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);

  const end = Buffer.alloc(NODE_HEADER_SIZE + 8);
  end.writeUInt16LE(RES_XML_END_ELEMENT_TYPE, 0);
  end.writeUInt16LE(NODE_HEADER_SIZE, 2);
  end.writeUInt32LE(NODE_HEADER_SIZE + 8, 4);
  end.writeUInt32LE(element.endLine || element.line, 8);
  end.writeUInt32LE(NO_INDEX, 12);
  end.writeUInt32LE(element.namespace === null ? NO_INDEX : strings.index(element.namespace), 16);
  end.writeUInt32LE(strings.index(element.name), 20);

  const chunks: Buffer[] = [header, ...attributes];
  for (const child of element.children) chunks.push(...encodeElement(child, strings));
  chunks.push(end);
  return chunks;
}

function namespaceChunk(type: number, prefix: number, uri: number, line: number): Buffer {
  const chunk = Buffer.alloc(NODE_HEADER_SIZE + 8);
  chunk.writeUInt16LE(type, 0);
  chunk.writeUInt16LE(NODE_HEADER_SIZE, 2);
  chunk.writeUInt32LE(NODE_HEADER_SIZE + 8, 4);
  chunk.writeUInt32LE(line, 8);
  chunk.writeUInt32LE(NO_INDEX, 12);
  chunk.writeUInt32LE(prefix, 16);
  chunk.writeUInt32LE(uri, 20);
  return chunk;
}

function resourceMapChunk(attributeNames: string[], document: AxmlDocument): Buffer {
  const ids = attributeNames.map((name) => document.resourceIds.get(name) ?? 0);
  const chunk = Buffer.alloc(8 + ids.length * 4);
  chunk.writeUInt16LE(RES_XML_RESOURCE_MAP_TYPE, 0);
  chunk.writeUInt16LE(8, 2);
  chunk.writeUInt32LE(chunk.length, 4);
  ids.forEach((id, index) => chunk.writeUInt32LE(id, 8 + index * 4));
  return chunk;
}

function stringPoolChunk(values: string[]): Buffer {
  const encoded: Buffer[] = [];
  const offsets: number[] = [];
  let dataLength = 0;
  for (const value of values) {
    const item = encodeStringUtf16(value);
    offsets.push(dataLength);
    encoded.push(item);
    dataLength += item.length;
    const padding = (4 - (dataLength % 4)) % 4;
    if (padding > 0) {
      encoded.push(Buffer.alloc(padding));
      dataLength += padding;
    }
  }

  const tableLength = values.length * 4;
  const chunk = Buffer.alloc(STRING_POOL_HEADER_SIZE + tableLength + dataLength);
  chunk.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  chunk.writeUInt16LE(STRING_POOL_HEADER_SIZE, 2);
  chunk.writeUInt32LE(chunk.length, 4);
  chunk.writeUInt32LE(values.length, 8);
  chunk.writeUInt32LE(0, 12); // style count
  chunk.writeUInt32LE(0, 16); // flags: UTF-16, not sorted
  chunk.writeUInt32LE(STRING_POOL_HEADER_SIZE + tableLength, 20);
  chunk.writeUInt32LE(0, 24); // styles start
  offsets.forEach((offset, index) => chunk.writeUInt32LE(offset, STRING_POOL_HEADER_SIZE + index * 4));
  let cursor = STRING_POOL_HEADER_SIZE + tableLength;
  for (const item of encoded) {
    item.copy(chunk, cursor);
    cursor += item.length;
  }
  return chunk;
}

function encodeStringUtf16(value: string): Buffer {
  const body = Buffer.from(value, "utf16le");
  const length = value.length;
  const head = Buffer.alloc(length > 0x7fff ? 4 : 2);
  if (length > 0x7fff) {
    head.writeUInt16LE(0x8000 | ((length >>> 16) & 0x7fff), 0);
    head.writeUInt16LE(length & 0xffff, 2);
  } else {
    head.writeUInt16LE(length, 0);
  }
  return Buffer.concat([head, body, Buffer.from([0, 0])]);
}

function* walk(element: AxmlElement): Generator<AxmlElement> {
  yield element;
  for (const child of element.children) yield* walk(child);
}

function findAttribute(element: AxmlElement, name: string): AxmlAttribute | undefined {
  return element.attributes.find((attribute) => attribute.name === name);
}

function attributeString(attribute: AxmlAttribute | undefined): string | undefined {
  if (attribute === undefined) return undefined;
  return typeof attribute.value.data === "string" ? attribute.value.data : undefined;
}

function setString(attribute: AxmlAttribute, value: string): void {
  attribute.value = { type: TYPE_STRING, data: value };
  attribute.rawValue = value;
}

/**
 * Patch a binary AndroidManifest.xml.
 *
 * The template's MainActivity and foreground service classes live in the
 * template package, so class names must survive rebranding: only the package,
 * the package-derived permission names and provider authorities are rewritten.
 */
export function patchManifestAxml(buffer: Buffer, patch: ManifestPatch): Buffer {
  const document = decodeAxml(buffer);
  const manifest = document.root;
  if (manifest.name !== "manifest") {
    throw new Error(`AndroidManifest.xml root is <${manifest.name}>, not <manifest>`);
  }

  const packageAttribute = findAttribute(manifest, "package");
  const oldPackage = attributeString(packageAttribute);
  if (packageAttribute === undefined || oldPackage === undefined || oldPackage.length === 0) {
    throw new Error("AndroidManifest.xml has no package attribute");
  }
  if (oldPackage !== patch.packageName) {
    setString(packageAttribute, patch.packageName);
    for (const element of walk(manifest)) {
      for (const attribute of element.attributes) {
        if (attribute === packageAttribute) continue;
        if (!isRebranded(element, attribute)) continue;
        const current = attributeString(attribute);
        if (current === undefined) continue;
        const next = rebrand(current, oldPackage, patch.packageName);
        if (next !== current) setString(attribute, next);
      }
    }
  }

  const versionCode = findAttribute(manifest, "versionCode");
  if (patch.versionCode !== undefined && versionCode !== undefined) {
    versionCode.value = { type: TYPE_INT_DEC, data: patch.versionCode >>> 0 };
    versionCode.rawValue = null;
  }
  const versionName = findAttribute(manifest, "versionName");
  if (patch.versionName !== undefined && versionName !== undefined) {
    setString(versionName, patch.versionName);
  }
  const application = manifest.children.find((child) => child.name === "application");
  const label = application === undefined ? undefined : findAttribute(application, "label");
  if (patch.appName !== undefined && label !== undefined) {
    setString(label, patch.appName);
  }

  return encodeAxml(document);
}

/**
 * Whether an attribute is a package-derived identifier that must move with the
 * application ID.
 *
 * Class names (`android:name` on application/activity/service/receiver/provider)
 * point at code that still lives in the template package, so they stay.
 */
function isRebranded(element: AxmlElement, attribute: AxmlAttribute): boolean {
  if (attribute.name === "authorities") return true;
  if (attribute.name !== "name") return false;
  return element.name === "permission" || element.name === "uses-permission";
}

function rebrand(value: string, oldPackage: string, packageName: string): string {
  if (value === oldPackage) return packageName;
  if (value.startsWith(`${oldPackage}.`)) return `${packageName}${value.slice(oldPackage.length)}`;
  return value;
}

/** @deprecated Use [`decodeAxml`]; kept for callers of the old parser. */
export const parseAxml = decodeAxml;
