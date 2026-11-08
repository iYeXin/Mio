import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { prepareModuleDirectory } from "../src/bundle.js";

test("prepareModuleDirectory turns a proto APK into a bundle module", async () => {
  const root = await mkdtemp(join(tmpdir(), "mio-module-"));
  try {
    const stage = join(root, "stage");
    await mkdir(join(stage, "res"), { recursive: true });
    await mkdir(join(stage, "assets"), { recursive: true });
    await mkdir(join(stage, "lib", "arm64-v8a"), { recursive: true });
    await mkdir(join(stage, "kotlin"), { recursive: true });
    await writeFile(join(stage, "AndroidManifest.xml"), "proto-manifest");
    await writeFile(join(stage, "resources.pb"), "resources");
    await writeFile(join(stage, "classes.dex"), "dex1");
    await writeFile(join(stage, "classes2.dex"), "dex2");
    await writeFile(join(stage, "res", "a.png"), "png");
    await writeFile(join(stage, "assets", "app.asar"), "asar");
    await writeFile(join(stage, "lib", "arm64-v8a", "libapp.so"), "so");
    await writeFile(join(stage, "kotlin", "builtins"), "meta");

    const protoApk = join(root, "proto.apk");
    const zip = new yazl.ZipFile();
    const files = [
      "AndroidManifest.xml",
      "resources.pb",
      "classes.dex",
      "classes2.dex",
      "res/a.png",
      "assets/app.asar",
      "lib/arm64-v8a/libapp.so",
      "kotlin/builtins",
    ];
    for (const file of files) zip.addFile(join(stage, file), file);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      zip.outputStream
        .pipe(createWriteStream(protoApk))
        .on("close", resolvePromise)
        .on("error", rejectPromise);
      zip.end();
    });

    const moduleDir = join(root, "module");
    await prepareModuleDirectory(protoApk, moduleDir);

    assert.equal(await readFile(join(moduleDir, "manifest", "AndroidManifest.xml"), "utf8"), "proto-manifest");
    assert.equal(await readFile(join(moduleDir, "resources.pb"), "utf8"), "resources");
    assert.equal(await readFile(join(moduleDir, "dex", "classes.dex"), "utf8"), "dex1");
    assert.equal(await readFile(join(moduleDir, "dex", "classes2.dex"), "utf8"), "dex2");
    assert.equal(await readFile(join(moduleDir, "res", "a.png"), "utf8"), "png");
    assert.equal(await readFile(join(moduleDir, "assets", "app.asar"), "utf8"), "asar");
    assert.equal(await readFile(join(moduleDir, "lib", "arm64-v8a", "libapp.so"), "utf8"), "so");
    assert.equal(await readFile(join(moduleDir, "root", "kotlin", "builtins"), "utf8"), "meta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});