import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type AndroidAbi = "universal" | "arm64" | "x64";

export interface MioConfig {
  app: {
    id: string;
    name: string;
    version: string;
    icon?: string;
  };
  window?: {
    width?: number;
    height?: number;
    title?: string;
    backgroundColor?: string;
    /** Initial position; the window is centred when omitted. */
    x?: number;
    y?: number;
    center?: boolean;
    resizable?: boolean;
    /** Set false for a custom title bar; combine with window.startDragging(). */
    decorations?: boolean;
    alwaysOnTop?: boolean;
    minWidth?: number;
    minHeight?: number;
  };
  web?: {
    outDir?: string;
    buildCommand?: string;
    devCommand?: string;
    devUrl?: string;
  };
  android?: {
    template?: string;
    /** Which prebuilt template to inject into. Default: universal. */
    abi?: AndroidAbi;
    minSdk?: number;
    pageSize?: 4 | 16;
    /** Allows `foreground.start`, which keeps the process alive in the background. */
    foregroundService?: boolean;
    keystore?: string;
    alias?: string;
    storePasswordEnv?: string;
    keyPasswordEnv?: string;
  };
  windows?: {
    templateDir?: string;
    exe?: string;
    signCommand?: string;
  };
}

export interface LoadedConfig {
  config: MioConfig;
  path: string;
  projectDir: string;
}

const APP_ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const ANDROID_ABIS: readonly AndroidAbi[] = ["universal", "arm64", "x64"];

export async function loadConfig(
  projectDir: string,
  configPath = "mio.config.json",
): Promise<LoadedConfig> {
  const path = resolve(projectDir, configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("mio.config.json must be an object");
  }
  const config = parsed as MioConfig;
  if (!config.app || typeof config.app !== "object") {
    throw new Error("mio.config.json is missing app");
  }
  for (const key of ["id", "name", "version"] as const) {
    if (typeof config.app[key] !== "string" || config.app[key].length === 0) {
      throw new Error(`mio.config.json app.${key} is required`);
    }
  }
  if (!APP_ID.test(config.app.id)) {
    throw new Error(`Invalid Android application id: ${config.app.id}`);
  }
  const abi = config.android?.abi;
  if (abi !== undefined && !ANDROID_ABIS.includes(abi)) {
    throw new Error(
      `Invalid android.abi: ${String(abi)} (expected one of ${ANDROID_ABIS.join(", ")})`,
    );
  }
  return { config, path, projectDir };
}

export function resolveFromProject(projectDir: string, value: string | undefined): string | undefined {
  return value ? resolve(projectDir, value) : undefined;
}
