import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

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
    /**
     * Splash image shown while the page loads. Relative to the project root;
     * copied into the app archive at build time.
     */
    splash?: string;
    /** Background behind the splash; defaults to `window.backgroundColor`. */
    splashBackground?: string;
    /** How the splash image fills the window. Default: `contain`. */
    splashFit?: "contain" | "cover";
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
  /** Enables WebView devtools. Defaults to on in `mio dev`, off in builds. */
  devtools?: boolean;
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
    /** Output executable name, e.g. "Notes.exe". The template's own exe is found automatically. */
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
const SPLASH_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_SPLASH_BYTES = 12 * 1024 * 1024;

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
  if (config.devtools !== undefined && typeof config.devtools !== "boolean") {
    throw new Error("Invalid devtools: expected a boolean");
  }
  const exe = config.windows?.exe;
  if (exe !== undefined && (exe.includes("/") || exe.includes("\\\\") || !exe.toLowerCase().endsWith(".exe"))) {
    throw new Error(
      `Invalid windows.exe: ${exe} (expected a file name like "Notes.exe"; it is the output name, not a template path)`,
    );
  }
  const abi = config.android?.abi;
  if (abi !== undefined && !ANDROID_ABIS.includes(abi)) {
    throw new Error(
      `Invalid android.abi: ${String(abi)} (expected one of ${ANDROID_ABIS.join(", ")})`,
    );
  }
  const splash = config.window?.splash;
  if (splash !== undefined) {
    if (typeof splash !== "string" || splash.trim().length === 0) {
      throw new Error("Invalid window.splash: expected a file path");
    }
    const splashPath = resolve(projectDir, splash);
    let info;
    try {
      info = await stat(splashPath);
    } catch {
      throw new Error(`window.splash does not exist: ${splashPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`window.splash is not a file: ${splashPath}`);
    }
    if (!SPLASH_EXTENSIONS.has(extname(splashPath).toLowerCase())) {
      throw new Error("Invalid window.splash: expected .png, .jpg, .jpeg or .webp");
    }
    if (info.size > MAX_SPLASH_BYTES) {
      throw new Error("Invalid window.splash: image is larger than 12 MB");
    }
    const fit = config.window?.splashFit;
    if (fit !== undefined && fit !== "contain" && fit !== "cover") {
      throw new Error('Invalid window.splashFit: expected "contain" or "cover"');
    }
    const background = config.window?.splashBackground;
    if (background !== undefined && !COLOR_PATTERN.test(background)) {
      throw new Error('Invalid window.splashBackground: expected #rgb, #rrggbb or #aarrggbb');
    }
  }
  return { config, path, projectDir };
}

export function resolveFromProject(projectDir: string, value: string | undefined): string | undefined {
  return value ? resolve(projectDir, value) : undefined;
}
