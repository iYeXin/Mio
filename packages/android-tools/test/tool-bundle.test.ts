import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import {
  MioToolError,
  installToolBundle,
  platformKeyOf,
  type ToolBundleManifest,
} from "../src/index.js";

const platform = platformKeyOf(process.platform, process.arch);
const windows = process.platform === "win32";
const javaName = windows ? "java.exe" : "java";
const zipalignName = windows ? "zipalign.exe" : "zipalign";

interface Archive {
  path: string;
  sha256: string;
  size: number;
}

async function makeArchive(
  root: string,
  name: string,
  files: Record<string, string>,
  entries: string[],
): Promise<Archive> {
  const stage = join(root, `stage-${name}`);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(stage, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  const archive = join(root, `${name}.tar.gz`);
  await tar.c({ gzip: true, cwd: stage, file: archive }, entries);
  const data = await readFile(archive);
  return {
    path: archive,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  };
}

async function makeBundle(root: string): Promise<{ tools: Archive; jre: Archive }> {
  const tools = await makeArchive(
    root,
    "tools",
    {
      "apksigner.jar": "dummy-apksigner",
      [zipalignName]: "dummy-zipalign",
    },
    ["apksigner.jar", zipalignName],
  );
  const jre = await makeArchive(
    root,
    "jre",
    { [`jre/bin/${javaName}`]: "dummy-java" },
    ["jre"],
  );
  return { tools, jre };
}

function makeManifest(
  bundle: { tools: Archive; jre: Archive },
  version = "1",
): ToolBundleManifest {
  return {
    schemaVersion: 2,
    latest: version,
    bundles: {
      [version]: {
        platforms: {
          [platform]: {
            tools: {
              url: pathToFileURL(bundle.tools.path).href,
              sha256: bundle.tools.sha256,
              size: bundle.tools.size,
              strip: 0,
            },
            jre: {
              url: pathToFileURL(bundle.jre.path).href,
              sha256: bundle.jre.sha256,
              size: bundle.jre.size,
              strip: 1,
            },
          },
        },
      },
    },
  };
}

test("installs both components, then reuses the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest(bundle);
    const cacheDir = join(root, "cache");

    const first = await installToolBundle({ manifest, cacheDir });
    assert.deepEqual(first.installed.sort(), ["jre", "tools"]);
    assert.equal(first.version, "1");
    assert.equal(first.platform, platform);
    assert.ok(await readFile(join(first.dir, "apksigner.jar")));
    assert.ok(await readFile(join(first.dir, "jre", "bin", javaName)));

    const marker = JSON.parse(await readFile(join(first.dir, ".mio-tools.json"), "utf8"));
    assert.equal(marker.components.tools, bundle.tools.sha256);
    assert.equal(marker.components.jre, bundle.jre.sha256);

    const second = await installToolBundle({ manifest, cacheDir });
    assert.deepEqual(second.installed, []);
    assert.equal(second.dir, first.dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installs only the requested component", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest(bundle);
    const cacheDir = join(root, "cache");

    const jreOnly = await installToolBundle({ manifest, cacheDir, components: ["jre"] });
    assert.deepEqual(jreOnly.installed, ["jre"]);
    await assert.rejects(readFile(join(jreOnly.dir, "apksigner.jar")));

    const toolsOnly = await installToolBundle({ manifest, cacheDir, components: ["tools"] });
    assert.deepEqual(toolsOnly.installed, ["tools"]);
    assert.ok(await readFile(join(toolsOnly.dir, "apksigner.jar")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a bundle with a bad checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest(bundle);
    const entry = manifest.bundles["1"]!.platforms[platform]!;
    entry.tools!.sha256 = "0".repeat(64);

    await assert.rejects(
      () => installToolBundle({ manifest, cacheDir: join(root, "cache") }),
      (error: unknown) =>
        error instanceof MioToolError && error.code === "BUNDLE_CHECKSUM_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest(bundle);
    await assert.rejects(
      () => installToolBundle({ manifest, platform: "plan9-x64", cacheDir: join(root, "cache") }),
      /no build for plan9-x64/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
