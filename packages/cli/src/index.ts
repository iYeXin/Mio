import { parseArgs } from "node:util";
import { join } from "node:path";
import { MIO_CLI_VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { createProject } from "./create.js";
import { buildAndroid } from "./build-android.js";
import { buildWindows } from "./build-windows.js";
import { dev } from "./dev.js";
import { doctor } from "./doctor.js";
import { exists } from "./project.js";

const HELP = `Mio — lightweight cross-platform app framework

Usage:
  mio create [target]
  mio build [--platform android|windows] [--skip-web] [--template <path>] [--config mio.config.json]
  mio dev --platform android|windows [--no-install] [--template <path>]
  mio doctor

Examples:
  mio create hello
  mio build --platform android
  mio dev --platform windows
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      platform: { type: "string", multiple: true },
      abi: { type: "string" },
      template: { type: "string" },
      config: { type: "string" },
      "skip-web": { type: "boolean" },
      "no-install": { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(MIO_CLI_VERSION);
    return;
  }

  const command = positionals[0];
  if (!command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "create": {
      const target = positionals[1] ?? "mio-app";
      await createProject({ target });
      return;
    }
    case "build": {
      const loaded = await loadConfig(process.cwd(), values.config);
      if (values.abi) {
        const abi = values.abi;
        if (abi !== "universal" && abi !== "arm64" && abi !== "x64") {
          throw new Error(`Unknown --abi: ${abi} (expected universal, arm64 or x64)`);
        }
        loaded.config.android = { ...(loaded.config.android ?? {}), abi };
      }
      const platforms = normalizePlatforms(values.platform);
      for (const platform of platforms) {
        if (platform === "android") {
          const result = await buildAndroid({ loaded, skipWeb: values["skip-web"] ?? false, template: values.template });
          console.log(`Android: ${result.output} (${formatBytes(result.size)}, verified=${result.verified})`);
        } else {
          const result = await buildWindows({ loaded, skipWeb: values["skip-web"] ?? false, template: values.template });
          console.log(`Windows: ${result.outputDir} (${formatBytes(result.size)})`);
        }
      }
      return;
    }
    case "dev": {
      const loaded = await loadConfig(process.cwd(), values.config);
      const platform = normalizePlatforms(values.platform)[0] ?? "windows";
      await dev({ loaded, platform, install: !values["no-install"], template: values.template });
      return;
    }
    case "doctor": {
      const hasConfig = await exists(join(process.cwd(), values.config ?? "mio.config.json"));
      await doctor(hasConfig ? await loadConfig(process.cwd(), values.config) : undefined);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

function normalizePlatforms(values: string[] | undefined): Array<"android" | "windows"> {
  if (!values || values.length === 0) return ["android", "windows"];
  const parsed = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const platforms: Array<"android" | "windows"> = [];
  for (const value of parsed) {
    if (value !== "android" && value !== "windows") {
      throw new Error(`Unknown platform: ${value} (expected android or windows)`);
    }
    platforms.push(value);
  }
  return [...new Set(platforms)];
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
