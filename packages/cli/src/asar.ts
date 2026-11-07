import { copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import type { MioConfig } from "./config.js";
import { MIO_API_VERSION, MIO_CLI_VERSION } from "./constants.js";

export interface CreateAsarOptions {
  webDir: string;
  output: string;
  config: MioConfig;
}

export interface CreateAsarResult {
  output: string;
  size: number;
}

export async function createAppAsar(options: CreateAsarOptions): Promise<CreateAsarResult> {
  const stage = await mkdtemp(join(tmpdir(), "mio-asar-"));
  try {
    await cp(options.webDir, stage, { recursive: true });
    const manifest = {
      id: options.config.app.id,
      name: options.config.app.name,
      version: options.config.app.version,
      entry: "index.html",
      window: {
        width: options.config.window?.width ?? 1024,
        height: options.config.window?.height ?? 720,
        title: options.config.window?.title ?? options.config.app.name,
        backgroundColor: options.config.window?.backgroundColor ?? "#0f1115",
      },
      requires: {
        apiVersion: MIO_API_VERSION,
      },
      build: {
        cli: MIO_CLI_VERSION,
        api: MIO_API_VERSION,
      },
    };
    await writeFile(
      join(stage, "mio-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const require = createRequire(import.meta.url);
    const bootstrap = require.resolve("@iyexin/mio-api/bootstrap.js");
    await mkdir(join(stage, "__mio__"), { recursive: true });
    await copyFile(bootstrap, join(stage, "__mio__", "bootstrap.js"));

    await createPackage(stage, options.output);
    const info = await stat(options.output);
    return { output: options.output, size: info.size };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
