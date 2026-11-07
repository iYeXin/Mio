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

async function makeBundle(root: string): Promise<{
  archive: string;
  sha256: string;
  size: number;
}> {
  const stage = join(root, "stage");
  const bundleRoot = join(stage, platform);
  await mkdir(join(bundleRoot, "jre", "bin"), { recursive: true });
  await writeFile(join(bundleRoot, "apksigner.jar"), "dummy-apksigner");
  await writeFile(join(bundleRoot, zipalignName), "dummy-zipalign");
  await writeFile(join(bundleRoot, "jre", "bin", javaName), "dummy-java");

  const archive = join(root, "tools.tar.gz");
  await tar.c({ gzip: true, cwd: stage, file: archive }, [platform]);
  const data = await readFile(archive);
  return {
    archive,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  };
}

function makeManifest(
  bundle: { archive: string; sha256: string; size: number },
  version = "0.0.1",
): ToolBundleManifest {
  return {
    schemaVersion: 1,
    latest: version,
    bundles: {
      [version]: {
        platforms: {
          [platform]: {
            url: pathToFileURL(bundle.archive).href,
            sha256: bundle.sha256,
            size: bundle.size,
          },
        },
      },
    },
  };
}

test("installs a tool bundle, verifies checksum, and caches it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-"));
  try {
    const bundle = await makeBundle(root);
    const cacheDir = join(root, "cache");
    const manifest = makeManifest(bundle);

    const first = await installToolBundle({
      manifest,
      version: "0.0.1",
      platform,
      cacheDir,
    });

    assert.equal(first.version, "0.0.1");
    assert.equal(first.platform, platform);
    assert.equal(first.tools.source, "env-bundle");
    assert.match(first.tools.apksignerJar, /apksigner\.jar$/);
    assert.match(first.tools.zipalign, /zipalign(?:\.exe)?$/);
    assert.match(first.tools.java, /java(?:\.exe)?$/);

    const second = await installToolBundle({
      manifest,
      version: "0.0.1",
      platform,
      cacheDir,
    });
    assert.equal(second.dir, first.dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a bundle with a bad checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-bad-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest({ ...bundle, sha256: "0".repeat(64) });

    await assert.rejects(
      installToolBundle({
        manifest,
        version: "0.0.1",
        platform,
        cacheDir: join(root, "cache"),
      }),
      (error: unknown) => {
        assert.equal(error instanceof MioToolError, true);
        assert.equal((error as MioToolError).code, "BUNDLE_CHECKSUM_FAILED");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-bundle-platform-"));
  try {
    const bundle = await makeBundle(root);
    const manifest = makeManifest(bundle);

    await assert.rejects(
      installToolBundle({
        manifest,
        version: "0.0.1",
        platform: "plan9-x64",
        cacheDir: join(root, "cache"),
      }),
      (error: unknown) => {
        assert.equal(error instanceof MioToolError, true);
        assert.equal((error as MioToolError).code, "BUNDLE_DOWNLOAD_FAILED");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
