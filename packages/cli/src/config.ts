import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

export type AndroidAbi = "universal" | "arm64" | "x64";

/** Startup appearance: follow the system, or force light/dark. */
export type StartupTheme = "system" | "light" | "dark";

/**
 * How a system bar behaves.
 *
 * `visible` is the normal bar; `hidden` hides it but a swipe from the edge
 * brings it back and keeps it back; `immersive` hides it and a swipe only shows
 * it transiently.
 */
export type StatusBarMode = "visible" | "hidden" | "immersive";

/** A value that can differ between light and dark. */
export type Themed<T> = T | { light?: T; dark?: T };

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
    splash?: Themed<string>;
    /** Background behind the splash; defaults to `window.backgroundColor`. */
    splashBackground?: Themed<string>;
    /** How the splash image fills the window. Default: `contain`. */
    splashFit?: "contain" | "cover";
    /**
     * Startup appearance used by the shell before any page code runs: it picks
     * the matching splash variant and status bar icons. On Android 12+ it also
     * sets the application night mode, so the page's `prefers-color-scheme`
     * agrees with the splash it saw.
     */
    theme?: StartupTheme;
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
    /**
     * Rotation lock applied at startup. `auto` follows the device sensor,
     * `portrait`/`landscape` pin the activity. Default: `auto`.
     */
    orientation?: "auto" | "portrait" | "landscape";
    /**
     * Status bar behaviour at startup: `visible`, `hidden` (swipe brings it
     * back) or `immersive` (swipe only shows it briefly). Default: `visible`.
     */
    statusBar?: StatusBarMode;
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
  const statusBar = config.android?.statusBar;
  if (statusBar !== undefined && !STATUS_BAR_MODES.includes(statusBar)) {
    throw new Error(
      `Invalid android.statusBar: ${String(statusBar)} (expected one of ${STATUS_BAR_MODES.join(", ")})`,
    );
  }
  const orientation = config.android?.orientation;
  if (orientation !== undefined && !ORIENTATIONS.includes(orientation)) {
    throw new Error(
      `Invalid android.orientation: ${String(orientation)} (expected one of ${ORIENTATIONS.join(", ")})`,
    );
  }
  const theme = config.window?.theme;
  if (theme !== undefined && !THEMES.includes(theme)) {
    throw new Error(
      `Invalid window.theme: ${String(theme)} (expected one of ${THEMES.join(", ")})`,
    );
  }
  const fit = config.window?.splashFit;
  if (fit !== undefined && fit !== "contain" && fit !== "cover") {
    throw new Error('Invalid window.splashFit: expected "contain" or "cover"');
  }

  const splash = config.window?.splash;
  assertThemedShape(splash, "window.splash");
  for (const entry of themedEntries(splash)) {
    await assertSplash(projectDir, entry.variant, entry.value);
  }
  const backgrounds = config.window?.splashBackground;
  assertThemedShape(backgrounds, "window.splashBackground");
  for (const entry of themedEntries(backgrounds)) {
    if (!COLOR_PATTERN.test(entry.value)) {
      throw new Error(
        `Invalid ${labelFor("window.splashBackground", entry.variant)}: ` +
          `expected #rgb, #rrggbb or #aarrggbb`,
      );
    }
  }
  return { config, path, projectDir };
}

const STATUS_BAR_MODES: readonly StatusBarMode[] = ["visible", "hidden", "immersive"];
const ORIENTATIONS = ["auto", "portrait", "landscape"] as const;
const THEMES: readonly StartupTheme[] = ["system", "light", "dark"];

export type ThemedVariant = "" | "light" | "dark";

export interface ThemedEntry<T> {
  /** Empty when the value is shared by both brightnesses. */
  variant: ThemedVariant;
  value: T;
}

/**
 * Flattens `"x.png"` and `{ light, dark }` into entries, so validation and
 * packaging handle both shapes without repeating the branch.
 */
export function themedEntries<T>(value: Themed<T> | undefined): Array<ThemedEntry<T>> {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null) {
    return [{ variant: "", value: value as T }];
  }
  const entries: Array<ThemedEntry<T>> = [];
  for (const variant of ["light", "dark"] as const) {
    const entry = (value as { light?: T; dark?: T })[variant];
    if (entry !== undefined) entries.push({ variant, value: entry });
  }
  return entries;
}

function assertThemedShape(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null) return;
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new Error(`Invalid ${field}: expected a value or { light, dark }`);
  }
  for (const key of keys) {
    if (key !== "light" && key !== "dark") {
      throw new Error(`Invalid ${field}: unknown key "${key}" (expected light or dark)`);
    }
  }
}

function labelFor(field: string, variant: ThemedVariant): string {
  return variant ? `${field}.${variant}` : field;
}

async function assertSplash(
  projectDir: string,
  variant: ThemedVariant,
  value: unknown,
): Promise<void> {
  const label = labelFor("window.splash", variant);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected a file path`);
  }
  const splashPath = resolve(projectDir, value);
  let info;
  try {
    info = await stat(splashPath);
  } catch {
    throw new Error(`${label} does not exist: ${splashPath}`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a file: ${splashPath}`);
  }
  if (!SPLASH_EXTENSIONS.has(extname(splashPath).toLowerCase())) {
    throw new Error(`Invalid ${label}: expected .png, .jpg, .jpeg or .webp`);
  }
  if (info.size > MAX_SPLASH_BYTES) {
    throw new Error(`Invalid ${label}: image is larger than 12 MB`);
  }
}

export function resolveFromProject(projectDir: string, value: string | undefined): string | undefined {
  return value ? resolve(projectDir, value) : undefined;
}
