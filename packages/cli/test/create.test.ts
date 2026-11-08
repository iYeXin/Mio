import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "@electron/asar";
import { createAppAsar } from "../src/asar.js";
import { createProject } from "../src/create.js";
import { initProject, mergeGitignore, upgradeProject } from "../src/scaffold.js";
import { loadConfig } from "../src/config.js";
import { MIO_API_VERSION, MIO_API_PACKAGE_VERSION, MIO_CLI_VERSION } from "../src/constants.js";

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

test("init adds Mio to an existing project without touching its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-init-"));
  const target = join(root, "legacy");
  try {
    await mkdir(join(target, "src"), { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify(
        {
          name: "legacy-app",
          scripts: { dev: "vite --port 4000", test: "vitest" },
          dependencies: { react: "^19.0.0" },
          devDependencies: { vite: "^7.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFile(join(target, "src", "main.ts"), "export const kept = true;\n");

    const first = await initProject(target);
    assert.equal(first.created, false);
    assert.ok(first.changes.length > 0);

    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Existing entries win; only missing Mio entries are added.
    assert.equal(pkg.scripts.dev, "vite --port 4000");
    assert.equal(pkg.scripts.test, "vitest");
    assert.equal(pkg.dependencies.react, "^19.0.0");
    assert.equal(pkg.dependencies["@iyexin/mio-api"], `^${MIO_API_PACKAGE_VERSION}`);
    assert.equal(pkg.devDependencies.vite, "^7.0.0");
    assert.equal(pkg.devDependencies["@iyexin/mio-cli"], `^${MIO_CLI_VERSION}`);
    assert.ok(pkg.scripts["build:android"]);

    const config = JSON.parse(await readFile(join(target, "mio.config.json"), "utf8")) as {
      app: { id: string; name: string; icon?: string };
    };
    assert.equal(config.app.id, "dev.mio.legacy");
    assert.equal(config.app.name, "legacy");
    assert.equal(config.app.icon, undefined);

    const main = await readFile(join(target, "src", "main.ts"), "utf8");
    assert.equal(main, "export const kept = true;\n");

    // Second run is a no-op: no rewritten files, no extra changes.
    const before = await readFile(join(target, "package.json"), "utf8");
    const second = await initProject(target);
    assert.deepEqual(second.changes, []);
    assert.equal(await readFile(join(target, "package.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init keeps an existing mio.config.json byte for byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-init-"));
  const target = join(root, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name: "p" }));
    const config = '{\n  "app": { "id": "com.example.p", "name": "P", "version": "9.9.9" }\n}\n';
    await writeFile(join(target, "mio.config.json"), config);

    await initProject(target);
    assert.equal(await readFile(join(target, "mio.config.json"), "utf8"), config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create on a non-empty directory initializes instead of replacing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-create-existing-"));
  const target = join(root, "existing");
  try {
    await mkdir(join(target, "web"), { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name: "existing", scripts: { build: "vite build" } }));
    await writeFile(join(target, "web", "index.html"), "<!doctype html><title>mine</title>");

    await createProject({ target });

    assert.equal(
      await readFile(join(target, "web", "index.html"), "utf8"),
      "<!doctype html><title>mine</title>",
    );
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.scripts.build, "vite build");
    assert.ok(pkg.dependencies["@iyexin/mio-api"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade moves only the Mio packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-upgrade-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "app",
          dependencies: { "@iyexin/mio-api": "^0.1.10", react: "^19.0.0" },
          devDependencies: { "@iyexin/mio-cli": "^0.1.10", vite: "^7.0.0" },
        },
        null,
        2,
      ),
    );

    const result = await upgradeProject(root, "0.2.0");
    assert.equal(result.version, "0.2.0");
    assert.deepEqual(
      result.changes.map((change) => change.name).sort(),
      ["@iyexin/mio-api", "@iyexin/mio-cli"],
    );

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies["@iyexin/mio-api"], "^0.2.0");
    assert.equal(pkg.dependencies.react, "^19.0.0");
    assert.equal(pkg.devDependencies["@iyexin/mio-cli"], "^0.2.0");
    assert.equal(pkg.devDependencies.vite, "^7.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeGitignore only appends missing rules", () => {
  const first = mergeGitignore("\nnode_modules/\n.env\n");
  assert.ok(first.added.includes("build/"));
  assert.ok(first.value.startsWith("\nnode_modules/\n.env\n"));
  const second = mergeGitignore(first.value);
  assert.deepEqual(second.added, []);
  assert.equal(second.value, first.value);
});