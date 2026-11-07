import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { cliRoot } from "../src/project.js";
import { loadConfig } from "../src/config.js";
import { androidAbiOf, resolveAndroidTemplate } from "../src/templates.js";

// Template binaries are release assets, so a clean checkout may not have them.
const localTemplates = ["mio-shell-universal.apk", "mio-shell-arm64.apk"].every((name) =>
  existsSync(join(cliRoot, "templates", "android", name)),
);

async function projectWith(android: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mio-abi-"));
  await writeFile(
    join(root, "mio.config.json"),
    JSON.stringify({
      app: { id: "dev.mio.abitest", name: "ABI Test", version: "1.0.0" },
      android,
    }),
  );
  return root;
}

test("defaults to the universal template", async () => {
  const root = await projectWith({});
  try {
    const loaded = await loadConfig(root);
    assert.equal(androidAbiOf(loaded.config), "universal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves the arm64 template from the local template directory", { skip: !localTemplates }, async () => {
  const root = await projectWith({ abi: "arm64" });
  try {
    const loaded = await loadConfig(root);
    const template = await resolveAndroidTemplate(root, loaded.config);
    assert.match(template.path, /mio-shell-arm64\.apk$/);
    assert.equal(template.source, "local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves the universal template from the local template directory", { skip: !localTemplates }, async () => {
  const root = await projectWith({ abi: "universal" });
  try {
    const loaded = await loadConfig(root);
    const template = await resolveAndroidTemplate(root, loaded.config);
    assert.match(template.path, /mio-shell-universal\.apk$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a configured template that does not exist", async () => {
  const root = await projectWith({ template: "templates/missing.apk" });
  try {
    const loaded = await loadConfig(root);
    await assert.rejects(
      () => resolveAndroidTemplate(root, loaded.config),
      /Configured Android template does not exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an explicit template that is not an APK", async () => {
  const root = await projectWith({ template: "not-an-apk.apk" });
  try {
    await writeFile(join(root, "not-an-apk.apk"), "definitely not a zip");
    const loaded = await loadConfig(root);
    await assert.rejects(() => resolveAndroidTemplate(root, loaded.config), /not a zip\/APK/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown abi in the config", async () => {
  const root = await projectWith({ abi: "mips" });
  try {
    await assert.rejects(() => loadConfig(root), /Invalid android\.abi/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
