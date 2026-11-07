import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  describeAndroidTools,
  describeMissing,
  inspectAndroidTools,
  statusComplete,
  toolsFromStatus,
} from "@iyexin/mio-android-tools";
import type { LoadedConfig } from "./config.js";
import {
  androidAbiOf,
  describeTemplates,
  resolveAndroidTemplate,
  resolveWindowsTemplate,
} from "./templates.js";
import { MIO_API_VERSION, MIO_CLI_VERSION } from "./constants.js";

export async function doctor(loaded?: LoadedConfig): Promise<void> {
  console.log(`Mio CLI: ${MIO_CLI_VERSION}`);
  console.log(`Mio API: ${MIO_API_VERSION}`);
  console.log(`Node: ${process.version} (${process.platform}-${process.arch})`);
  console.log(`Working directory: ${process.cwd()}`);

  const status = await inspectAndroidTools();
  if (statusComplete(status)) {
    console.log("\nAndroid tools:");
    console.log(describeAndroidTools(toolsFromStatus(status)));
  } else {
    console.log(`\nAndroid tools: incomplete (${describeMissing(status)})`);
    console.log("  missing parts are downloaded automatically on the first Android build");
  }

  const adb = findAdb();
  console.log(`adb: ${adb ?? "not found"}`);

  const templates = await describeTemplates();
  console.log("\nTemplates:");
  for (const line of templates) console.log(`  ${line}`);

  if (loaded) {
    console.log(`\nProject: ${loaded.config.app.name} (${loaded.config.app.id})`);
    console.log(`Android abi: ${androidAbiOf(loaded.config)}`);
    try {
      const android = await resolveAndroidTemplate(loaded.projectDir, loaded.config);
      console.log(`Android template: ${android.path} (${android.source})`);
    } catch (error) {
      console.log(`Android template: MISSING — ${message(error)}`);
    }
    try {
      const windows = await resolveWindowsTemplate(loaded.projectDir, loaded.config);
      console.log(`Windows template: ${windows.path} (${windows.source})`);
    } catch (error) {
      console.log(`Windows template: MISSING — ${message(error)}`);
    }
  }
}

function findAdb(): string | undefined {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const candidate = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
