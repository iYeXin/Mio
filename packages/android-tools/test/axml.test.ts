import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import {
  decodeAxml,
  encodeAxml,
  patchManifestAxml,
  type AxmlDocument,
  type AxmlElement,
} from "../src/axml.js";

const here = dirname(fileURLToPath(import.meta.url));
// AndroidManifest.xml extracted from a real template build, so the round-trip
// covers everything Flutter's manifest contains (queries, provider, receiver).
const fixture = readFileSync(join(here, "fixtures", "template-manifest.axml"));

function shape(element: AxmlElement): unknown {
  return {
    namespace: element.namespace,
    name: element.name,
    line: element.line,
    endLine: element.endLine,
    attributes: element.attributes.map((attribute) => ({
      namespace: attribute.namespace,
      name: attribute.name,
      resourceId: attribute.resourceId,
      rawValue: attribute.rawValue,
      type: attribute.value.type,
      data: attribute.value.data,
    })),
    children: element.children.map(shape),
  };
}

function find(document: AxmlDocument, ...path: string[]): AxmlElement | undefined {
  let current: AxmlElement | undefined = document.root;
  for (const name of path) {
    current = current?.children.find((child) => child.name === name);
  }
  return current;
}

function attribute(element: AxmlElement | undefined, name: string) {
  return element?.attributes.find((entry) => entry.name === name);
}

function text(element: AxmlElement | undefined, name: string): string | undefined {
  const value = attribute(element, name)?.value.data;
  return typeof value === "string" ? value : undefined;
}

test("decodes the template manifest", () => {
  const document = decodeAxml(fixture);
  assert.equal(document.root.name, "manifest");
  assert.ok(
    document.namespaces.some(
      (namespace) => namespace.uri === "http://schemas.android.com/apk/res/android",
    ),
  );
  assert.equal(text(document.root, "package"), "dev.mio.mio_shell");

  const versionCode = attribute(document.root, "versionCode");
  assert.equal(versionCode?.resourceId, 0x0101021b);
  assert.equal(versionCode?.value.type, 0x10);
  assert.equal(versionCode?.value.data, 1);

  const application = find(document, "application");
  assert.ok(application);
  assert.equal(text(application, "label"), "Mio");

  let activity = find(document, "application", "activity");
  assert.equal(text(activity, "name"), "dev.mio.mio_shell.MainActivity");
  assert.equal(attribute(activity, "exported")?.value.type, 0x12);
  assert.equal(attribute(activity, "exported")?.value.data, 0xffffffff);

  const service = find(document, "application", "service");
  assert.equal(text(service, "name"), "dev.mio.mio_shell.MioForegroundService");

  const provider = find(document, "application", "provider");
  assert.equal(text(provider, "authorities"), "dev.mio.mio_shell.flutter.share_provider");

  const permission = find(document, "permission");
  assert.equal(
    text(permission, "name"),
    "dev.mio.mio_shell.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
  );
});

test("encode(decode(manifest)) keeps the document intact", () => {
  const before = decodeAxml(fixture);
  const encoded = encodeAxml(before);
  assert.equal(encoded.readUInt16LE(0), 0x0003);

  const after = decodeAxml(encoded);
  assert.deepEqual(shape(after.root), shape(before.root));
  assert.deepEqual(after.namespaces, before.namespaces);
  assert.deepEqual(
    [...after.resourceIds.entries()].sort(),
    [...before.resourceIds.entries()].sort(),
  );
});

test("encoding twice is stable", () => {
  const once = encodeAxml(decodeAxml(fixture));
  const twice = encodeAxml(decodeAxml(once));
  assert.deepEqual(shape(decodeAxml(twice).root), shape(decodeAxml(once).root));
});

test("rebranding rewrites package-derived identifiers, not class names", () => {
  const patched = patchManifestAxml(fixture, {
    packageName: "dev.example.app",
    versionCode: 42,
    versionName: "2.0.0",
    appName: "Demo App",
  });
  const document = decodeAxml(patched);
  assert.equal(text(document.root, "package"), "dev.example.app");

  const versionCode = attribute(document.root, "versionCode");
  assert.equal(versionCode?.value.type, 0x10);
  assert.equal(versionCode?.value.data, 42);
  assert.equal(versionCode?.rawValue, null);
  assert.equal(text(document.root, "versionName"), "2.0.0");

  const application = find(document, "application");
  assert.equal(text(application, "label"), "Demo App");
  // Class names point at code inside the template, so they must not move.
  assert.equal(text(find(document, "application", "activity"), "name"), "dev.mio.mio_shell.MainActivity");
  assert.equal(
    text(find(document, "application", "service"), "name"),
    "dev.mio.mio_shell.MioForegroundService",
  );
  assert.equal(
    text(find(document, "application", "provider"), "authorities"),
    "dev.example.app.flutter.share_provider",
  );
  const permission = find(document, "permission");
  assert.equal(
    text(permission, "name"),
    "dev.example.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
  );
  const grants = document.root.children.filter(
    (child) =>
      child.name === "uses-permission" &&
      text(child, "name")?.startsWith("dev.example.app."),
  );
  assert.equal(grants.length, 1);
  assert.equal(text(grants[0], "name"), text(permission, "name"));

  const internet = document.root.children.find(
    (child) => child.name === "uses-permission" && text(child, "name") === "android.permission.INTERNET",
  );
  assert.ok(internet, "unrelated permissions stay untouched");
});

test("patching with the same package keeps the manifest usable", () => {
  const same = patchManifestAxml(fixture, { packageName: "dev.mio.mio_shell" });
  const document = decodeAxml(same);
  assert.equal(text(document.root, "package"), "dev.mio.mio_shell");
  assert.equal(
    text(find(document, "application", "service"), "name"),
    "dev.mio.mio_shell.MioForegroundService",
  );
});

/**
 * aapt2 is the reference parser: when the SDK is around, check that it reads
 * our encoding exactly like the original manifest. Skipped elsewhere.
 */
const aapt2 = findAapt2();

test(
  "aapt2 reads the encoded manifest like the original",
  { skip: aapt2 === undefined ? "aapt2 not found" : false },
  async () => {
  const [original, round, patched] = await Promise.all([
    dump(aapt2!, fixture),
    dump(aapt2!, encodeAxml(decodeAxml(fixture))),
    dump(aapt2!, patchManifestAxml(fixture, { packageName: "dev.example.app" })),
  ]);
  assert.equal(round, original, "round-trip changes what aapt2 sees");
  assert.match(patched, /package="dev\.example\.app"/);
  assert.match(patched, /MioForegroundService" \(Raw: "dev\.mio\.mio_shell\.MioForegroundService"\)/);
});

async function dump(tool: string, manifest: Buffer): Promise<string> {
  const file = join(tmpdir(), `mio-axml-${process.pid}-${Math.random().toString(36).slice(2)}.zip`);
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(manifest, "AndroidManifest.xml");
    zip.end();
    zip.outputStream
      .pipe(createWriteStream(file))
      .on("close", resolve)
      .on("error", reject);
  });
  try {
    return execFileSync(tool, ["dump", "xmltree", file, "--file", "AndroidManifest.xml"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } finally {
    rmSync(file, { force: true });
  }
}

function findAapt2(): string | undefined {
  const explicit = process.env.MIO_AAPT2;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const home of homes) {
    const buildTools = join(home, "build-tools");
    if (!existsSync(buildTools)) continue;
    for (const version of readdirSync(buildTools).sort().reverse()) {
      for (const name of ["aapt2", "aapt2.exe"]) {
        const candidate = join(buildTools, version, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}
