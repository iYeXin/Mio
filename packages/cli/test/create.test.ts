import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "@electron/asar";
import { createAppAsar } from "../src/asar.js";
import { createProject } from "../src/create.js";
import { loadConfig } from "../src/config.js";
import { MIO_API_VERSION, MIO_API_PACKAGE_VERSION } from "../src/constants.js";

const MINIMAL_CONFIG = {
  app: { id: "dev.mio.testapp", name: "Test App", version: "2.3.4" },
  window: { width: 800, height: 600 },
};

test("createAppAsar writes a manifest with the API requirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-asar-test-"));
  try {
    const web = join(root, "web");
    await mkdir(web, { recursive: true });
    await writeFile(join(web, "index.html"), "<!doctype html><title>t</title>");

    const asarPath = join(root, "app.asar");
    const result = await createAppAsar({
      webDir: web,
      output: asarPath,
      config: MINIMAL_CONFIG,
    });
    assert.ok(result.size > 0);

    const manifest = JSON.parse(
      extractFile(asarPath, "mio-manifest.json").toString("utf8"),
    ) as {
      id: string;
      name: string;
      version: string;
      requires: { apiVersion: string };
      build: { api: string };
    };

    assert.equal(manifest.id, MINIMAL_CONFIG.app.id);
    assert.equal(manifest.version, MINIMAL_CONFIG.app.version);
    assert.equal(manifest.requires.apiVersion, MIO_API_VERSION);
    assert.equal(manifest.build.api, MIO_API_VERSION);

    // The bootstrap script must be inside the archive so the shell can serve it.
    assert.ok(extractFile(asarPath, "__mio__/bootstrap.js").length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createProject scaffolds a project that depends on the published api package", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-create-"));
  const target = join(root, "my-app");
  try {
    await createProject({ target });
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, "my-app");
    assert.equal(pkg.dependencies["@iyexin/mio-api"], `^${MIO_API_PACKAGE_VERSION}`);
    const config = JSON.parse(await readFile(join(target, "mio.config.json"), "utf8")) as {
      app: { id: string };
    };
    assert.equal(config.app.id, "dev.mio.my_app");
    const loaded = await loadConfig(target);
    assert.equal(loaded.config.app.name, "my-app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects an invalid application id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-config-"));
  try {
    await writeFile(
      join(root, "mio.config.json"),
      JSON.stringify({ app: { id: "not valid", name: "X", version: "1.0.0" } }),
    );
    await assert.rejects(() => loadConfig(root), /Invalid Android application id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
