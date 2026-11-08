import { homedir } from "node:os";
import { join } from "node:path";
import {
  bundleComplete,
  describeMissing,
  ensureAndroidTools,
  inspectAndroidTools,
  statusComplete,
} from "@iyexin/mio-android-tools";
import type { AndroidAbi, LoadedConfig, MioConfig } from "./config.js";
import { MIO_CLI_VERSION, MIO_RELEASE_BASE } from "./constants.js";
import { resolveProxy } from "./download.js";
import { resolveAndroidTemplate, resolveWindowsTemplate } from "./templates.js";

export interface ToolsCommandOptions {
  action: "status" | "install";
  /** Which targets to fetch; defaults to android. */
  platform?: "android" | "windows" | "all";
  /** AAB additionally needs aapt2 + bundletool. */
  format?: "apk" | "aab";
  /** Template ABI for Android; defaults to the project config. */
  abi?: AndroidAbi;
  loaded?: LoadedConfig;
  cwd: string;
}

const TOOL_MANIFEST = `${MIO_RELEASE_BASE}/v${MIO_CLI_VERSION}/mio-tools.json`;

export async function toolsCommand(options: ToolsCommandOptions): Promise<void> {
  if (options.action === "install") {
    await installTools(options);
    return;
  }
  await showToolsStatus();
}

async function showToolsStatus(): Promise<void> {
  const status = await inspectAndroidTools();
  console.log("Android toolchain:");
  const row = (label: string, value: string | undefined): void =>
    console.log(`  ${label.padEnd(13)} ${value ?? "not found"}`);
  row("java", status.java);
  row("apksigner", status.apksignerJar);
  row("zipalign", status.zipalign);
  row("jarsigner", status.jarsigner);
  row("aapt2", status.aapt2);
  row("bundletool", status.bundletoolJar);
  row("keytool", status.keytool);

  const signingReady = statusComplete(status);
  const bundleReady = bundleComplete(status);
  console.log("");
  console.log(`APK builds: ${signingReady ? "ready" : `incomplete (${describeMissing(status)})`}`);
  console.log(
    `AAB builds: ${bundleReady ? "ready" : `incomplete (${describeMissing(status, { bundle: true })})`}`,
  );
  console.log(`cache: ${join(homedir(), ".mio", "tools", "android")}`);
  console.log("");
  console.log("Fetch what is missing with `mio tools install` (add `--format aab` for bundles).");
}

async function installTools(options: ToolsCommandOptions): Promise<void> {
  const platform = options.platform ?? "android";
  const format = options.format ?? "apk";
  const cwd = options.cwd;
  const config = options.loaded?.config ?? fallbackConfig(options.abi);
  const projectDir = options.loaded?.projectDir ?? cwd;
  const log = (message: string): void => console.error(`[tools] ${message}`);

  if (platform === "android" || platform === "all") {
    if (options.abi) config.android = { ...(config.android ?? {}), abi: options.abi };
    if (format === "aab" && config.android?.abi !== "universal") {
      config.android = { ...(config.android ?? {}), abi: "universal" };
    }

    const resolved = await ensureAndroidTools({
      manifest: process.env.MIO_TOOLS_MANIFEST_URL ?? TOOL_MANIFEST,
      allowDownload: process.env.MIO_NO_TOOL_DOWNLOAD !== "1",
      force: process.env.MIO_TOOLS_FORCE_DOWNLOAD === "1",
      cacheDir: process.env.MIO_TOOLS_CACHE_DIR,
      proxy: resolveProxy(),
      needBundle: format === "aab",
      log,
    });
    if (resolved.installed.length > 0) {
      console.log(`tool components: ${resolved.installed.join(", ")}`);
    } else {
      console.log("tool components: already cached");
    }

    const template = await resolveAndroidTemplate(projectDir, config, { log });
    console.log(`android template: ${template.path} (${template.source})`);
  }

  if (platform === "windows" || platform === "all") {
    const template = await resolveWindowsTemplate(projectDir, config, { log });
    console.log(`windows template: ${template.path} (${template.source})`);
  }
}

function fallbackConfig(abi?: AndroidAbi): MioConfig {
  return {
    app: { id: "dev.mio.tools", name: "mio-tools", version: "1.0.0" },
    web: { outDir: "dist" },
    android: { abi: abi ?? "universal" },
  };
}
