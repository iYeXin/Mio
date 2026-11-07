import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAndroidTools, discoverAndroidTools } from "../src/discover.js";

// These are integration tests against a real Android SDK. They are opt-in so CI
// does not depend on which build-tools a runner happens to preinstall:
//   MIO_TEST_ANDROID_TOOLS=1 pnpm --filter @iyexin/mio-android-tools test
const hasAndroidTools = process.env.MIO_TEST_ANDROID_TOOLS === "1";

test(
  "discovers Android tools from the local SDK or Mio bundle",
  { skip: hasAndroidTools ? false : "Android SDK/tools are not configured" },
  async () => {
    const tools = await discoverAndroidTools();
    assert.equal(typeof tools.java, "string");
    assert.match(tools.apksignerJar, /apksigner\.jar$/);
    assert.match(tools.zipalign, /zipalign(?:\.exe)?$/);
    const description = describeAndroidTools(tools);
    assert.match(description, /apksigner:/);
    assert.match(description, /zipalign:/);
  },
);
