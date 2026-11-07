import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MioToolError,
  checkAlignment,
  discoverAndroidTools,
  ensureDebugKeystore,
  signApk,
  verifyApk,
  type AndroidTools,
} from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// These are integration tests against a real Android SDK. They are opt-in so CI
// does not depend on which build-tools a runner happens to preinstall:
//   MIO_TEST_ANDROID_TOOLS=1 pnpm --filter @iyexin/mio-android-tools test
const hasAndroidTools = process.env.MIO_TEST_ANDROID_TOOLS === "1";

const skip = hasAndroidTools ? false : "Android SDK/tools are not configured";
let toolsPromise: Promise<AndroidTools> | undefined;

function getTools(): Promise<AndroidTools> {
  toolsPromise ??= discoverAndroidTools();
  return toolsPromise;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mio-android-tools-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("signs v2/v3 and verifies alignment for minSdk 24", { skip }, async () => {
  const tools = await getTools();
  await withTempDir(async (dir) => {
    const output = join(dir, "signed.apk");
    const result = await signApk({
      tools,
      input: fixture("base.apk"),
      output,
      keystore: fixture("test.p12"),
      keystorePassword: "password",
      keyAlias: "test",
      minSdkVersion: 24,
      pageSize: 16,
    });

    assert.equal(result.verify.verified, true);
    assert.equal(result.verify.v1, false);
    assert.equal(result.verify.v2, true);
    assert.equal(result.verify.v3, true);
    assert.equal(result.verify.signers.length, 1);
    assert.match(result.verify.signers[0]?.dn ?? "", /CN=Mio Test/);

    const alignment = await checkAlignment(tools, output, { pageSize: 16 });
    assert.equal(alignment.ok, true, alignment.raw);
  });
});

test("signs v1/v2/v3 for minSdk 21", { skip }, async () => {
  const tools = await getTools();
  await withTempDir(async (dir) => {
    const output = join(dir, "signed-v1.apk");
    const result = await signApk({
      tools,
      input: fixture("base.apk"),
      output,
      keystore: fixture("test.p12"),
      keystorePassword: "password",
      keyAlias: "test",
      minSdkVersion: 21,
      pageSize: 4,
    });

    assert.equal(result.verify.verified, true);
    assert.equal(result.verify.v1, true);
    assert.equal(result.verify.v2, true);
    assert.equal(result.verify.v3, true);
  });
});

test("fails with a useful error for a wrong keystore password", { skip }, async () => {
  const tools = await getTools();
  await withTempDir(async (dir) => {
    await assert.rejects(
      signApk({
        tools,
        input: fixture("base.apk"),
        output: join(dir, "bad.apk"),
        keystore: fixture("test.p12"),
        keystorePassword: "not-the-password",
        keyAlias: "test",
        minSdkVersion: 24,
      }),
      (error: unknown) => {
        assert.equal(error instanceof MioToolError, true);
        assert.equal((error as MioToolError).code, "APKSIGNER_SIGN_FAILED");
        return true;
      },
    );
  });
});

test("generates a debug keystore and signs with it", { skip }, async () => {
  const tools = await getTools();
  await withTempDir(async (dir) => {
    const keystore = join(dir, "debug.p12");
    const debug = await ensureDebugKeystore(tools, { path: keystore });
    assert.equal(debug.alias, "mio-debug");

    const output = join(dir, "debug-signed.apk");
    const result = await signApk({
      tools,
      input: fixture("base.apk"),
      output,
      keystore,
      keystorePassword: debug.password,
      keyAlias: debug.alias,
      minSdkVersion: 24,
    });

    assert.equal(result.verify.verified, true);
    assert.equal(result.verify.v2, true);
    assert.equal(result.verify.v3, true);
  });
});

test("verifyApk exposes the verification result", { skip }, async () => {
  const tools = await getTools();
  await withTempDir(async (dir) => {
    const output = join(dir, "signed.apk");
    await signApk({
      tools,
      input: fixture("base.apk"),
      output,
      keystore: fixture("test.p12"),
      keystorePassword: "password",
      keyAlias: "test",
      minSdkVersion: 24,
    });

    const result = await verifyApk(output, { tools, minSdkVersion: 24 });
    assert.equal(result.verified, true);
    assert.equal(result.v2, true);
  });
});
