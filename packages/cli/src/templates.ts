import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extractZip, listZipEntries } from "@iyexin/mio-android-tools";
import { fetchText, fetchToFile } from "./download.js";
import { MIO_API_VERSION, MIO_CLI_VERSION } from "./constants.js";
import type { AndroidAbi, LoadedConfig, MioConfig } from "./config.js";
import { cliRoot, exists } from "./project.js";

/**
 * Templates are no longer committed to the repository: they are release assets
 * (see .github/workflows/release.yml), downloaded on first use and cached per
 * CLI version. An explicit path always wins, so teams can ship their own build.
 */

const RELEASE_BASE = "https://github.com/iYeXin/Mio/releases/download";

export type TemplateSource = "explicit" | "local" | "cache";

export interface TemplateFile {
  name: string;
  sha256: string;
  size: number;
  abi?: AndroidAbi;
  kind?: "apk" | "zip";
}

export interface TemplateManifest {
  templateVersion: string;
  apiVersion: string;
  builtAt?: string;
  files: Record<string, TemplateFile>;
}

export interface ResolvedTemplate {
  path: string;
  source: TemplateSource;
  version: string | null;
}

export class TemplateError extends Error {}

function cacheRoot(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "mio", "templates", MIO_CLI_VERSION);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}



function assertCompatible(manifest: TemplateManifest, source: string): void {
  const wanted = MIO_API_VERSION.split(".")[0];
  const found = String(manifest.apiVersion ?? "").split(".")[0];
  if (!found) {
    throw new TemplateError(`${source} has no apiVersion; cannot verify compatibility`);
  }
  if (found !== wanted) {
    throw new TemplateError(
      `${source} targets Mio API ${manifest.apiVersion}, this CLI implements ${MIO_API_VERSION}. ` +
        `Use a template from the v${MIO_CLI_VERSION} release, or upgrade the CLI.`,
    );
  }
}

async function readManifest(directory: string): Promise<TemplateManifest | null> {
  const path = join(directory, "manifest.json");
  if (!(await exists(path))) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as TemplateManifest;
  } catch {
    throw new TemplateError(`Template manifest is not valid JSON: ${path}`);
  }
}

/** Downloads and unpacks the template bundle into the per-version cache. */
async function fetchTemplates(log: (message: string) => void): Promise<TemplateManifest> {
  const root = cacheRoot();
  const manifestUrl = `${RELEASE_BASE}/v${MIO_CLI_VERSION}/manifest.json`;
  log(`Downloading template manifest: ${manifestUrl}`);
  const manifest = JSON.parse(await fetchText(manifestUrl)) as TemplateManifest;
  assertCompatible(manifest, `release v${MIO_CLI_VERSION}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const [key, file] of Object.entries(manifest.files)) {
    const target = join(root, file.name);
    if (await exists(target)) {
      if ((await sha256(target)) === file.sha256) continue;
      await rm(target, { force: true });
    }
    const url = `${RELEASE_BASE}/v${MIO_CLI_VERSION}/${file.name}`;
    log(`Downloading ${key}: ${file.name} (${formatBytes(file.size)})`);
    await fetchToFile(url, target);
    const actual = await sha256(target);
    if (actual !== file.sha256) {
      await rm(target, { force: true });
      throw new TemplateError(
        `Checksum mismatch for ${file.name}: expected ${file.sha256}, got ${actual}`,
      );
    }
    if (file.kind === "zip") {
      const directory = join(root, stripArchiveSuffix(file.name));
      await extractZip(target, directory);
      await writeFile(join(directory, ".mio-template"), `${file.sha256}\n`, "utf8");
      await rm(target, { force: true });
    }
  }
  return manifest;
}

function stripArchiveSuffix(name: string): string {
  return name.replace(/\.zip$/i, "");
}

async function ensureTemplates(log: (message: string) => void): Promise<TemplateManifest> {
  const root = cacheRoot();
  const manifest = await readManifest(root);
  if (!manifest) return await fetchTemplates(log);
  assertCompatible(manifest, `template cache ${root}`);
  return manifest;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const ABI_KEY: Record<AndroidAbi, string> = {
  universal: "android-universal",
  arm64: "android-arm64",
  x64: "android-x64",
};

const LOCAL_APK: Record<AndroidAbi, string> = {
  universal: "mio-shell-universal.apk",
  arm64: "mio-shell-arm64.apk",
  x64: "mio-shell-x64.apk",
};

/** Templates built into the checkout by scripts/build-templates.ps1. */
function localTemplateRoot(): string {
  return join(cliRoot, "templates");
}

async function localAndroidTemplate(abi: AndroidAbi): Promise<ResolvedTemplate | null> {
  const path = join(localTemplateRoot(), "android", LOCAL_APK[abi]);
  if (!(await exists(path))) return null;
  await assertApkFormat(path);
  return { path, source: "local", version: null };
}

async function localWindowsTemplate(): Promise<ResolvedTemplate | null> {
  const path = join(localTemplateRoot(), "windows");
  if (!(await exists(join(path, "data")))) return null;
  return { path, source: "local", version: null };
}

export function androidAbiOf(config: MioConfig): AndroidAbi {
  return config.android?.abi ?? "universal";
}

/** Checks the zip layout of a template APK without unpacking it. */
async function assertApkFormat(path: string): Promise<void> {
  let entries: string[];
  try {
    entries = await listZipEntries(path);
  } catch (error) {
    throw new TemplateError(`Template is not a zip/APK: ${path} (${message(error)})`);
  }
  if (!entries.includes("AndroidManifest.xml")) {
    throw new TemplateError(`Template is not an APK (no AndroidManifest.xml): ${path}`);
  }
  if (!entries.some((entry) => entry.endsWith("libapp.so"))) {
    throw new TemplateError(`Template APK has no Flutter engine libraries: ${path}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abisInApk(path: string): Promise<Set<string>> {
  const entries = await listZipEntries(path);
  const abis = new Set<string>();
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\//.exec(entry);
    if (match?.[1]) abis.add(match[1]);
  }
  return abis;
}

export interface TemplateOptions {
  /** Explicit path from --template or MIO_*_TEMPLATE. */
  explicit?: string;
  log?: (message: string) => void;
}

async function resolveExplicitAndroid(path: string, abi: AndroidAbi): Promise<ResolvedTemplate> {
  await assertApkFormat(path);
  if (abi !== "universal") {
    const abis = await abisInApk(path);
    if (!abis.has(`arm64-v8a`) && !abis.has(`x86_64`) && !abis.has(`armeabi-v7a`)) {
      throw new TemplateError(`Template APK has no native libraries: ${path}`);
    }
    const wanted = abi === "arm64" ? "arm64-v8a" : abi === "x64" ? "x86_64" : "armeabi-v7a";
    if (!abis.has(wanted)) {
      throw new TemplateError(
        `Template ${path} does not contain ${wanted}; it has ${[...abis].join(", ") || "none"}. ` +
          `Build with --target-platform android-${abi}.`,
      );
    }
  }
  return { path, source: "explicit", version: null };
}

export async function resolveAndroidTemplate(
  projectDir: string,
  config: MioConfig,
  options: TemplateOptions = {},
): Promise<ResolvedTemplate> {
  const abi = androidAbiOf(config);
  const log = options.log ?? (() => {});

  const explicit = [
    options.explicit,
    config.android?.template ? resolve(projectDir, config.android.template) : undefined,
    process.env.MIO_ANDROID_TEMPLATE,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of explicit) {
    if (await exists(candidate)) return await resolveExplicitAndroid(candidate, abi);
  }
  if (explicit.length > 0) {
    throw new TemplateError(`Configured Android template does not exist: ${explicit[0]}`);
  }

  // Local builds (repo checkout, or a team that vendors its own templates) win
  // over downloading: the directory is gitignored, so it only exists on purpose.
  const local = await localAndroidTemplate(abi);
  if (local) return local;

  const manifest = await ensureTemplates(log);
  const file = manifest.files[ABI_KEY[abi]];
  if (!file) {
    throw new TemplateError(
      `Release v${MIO_CLI_VERSION} has no ${ABI_KEY[abi]} template. ` +
        `Available: ${Object.keys(manifest.files).join(", ")}. ` +
        `Build one locally with \`./scripts/build-templates.ps1 -Abi ${abi}\`.`,
    );
  }
  const path = join(cacheRoot(), file.name);
  if (!(await exists(path))) {
    throw new TemplateError(`Template file is missing from the cache: ${path}`);
  }
  // The release can be rebuilt for the same tag; a cached file must still match
  // the manifest it was downloaded with, otherwise the CLI would silently use a
  // different shell than the apiVersion it verified.
  if ((await sha256(path)) !== file.sha256) {
    await rm(path, { force: true });
    await fetchTemplates(log);
  }
  await assertApkFormat(path);
  return { path, source: "cache", version: manifest.templateVersion };
}

export async function resolveWindowsTemplate(
  projectDir: string,
  config: MioConfig,
  options: TemplateOptions = {},
): Promise<ResolvedTemplate> {
  const log = options.log ?? (() => {});
  const explicit = [
    options.explicit,
    config.windows?.templateDir ? resolve(projectDir, config.windows.templateDir) : undefined,
    process.env.MIO_WINDOWS_TEMPLATE,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of explicit) {
    if (!(await exists(candidate))) continue;
    if (!(await exists(join(candidate, "data")))) {
      throw new TemplateError(`Windows template directory has no data/ folder: ${candidate}`);
    }
    return { path: candidate, source: "explicit", version: null };
  }
  if (explicit.length > 0) {
    throw new TemplateError(`Configured Windows template does not exist: ${explicit[0]}`);
  }

  const local = await localWindowsTemplate();
  if (local) return local;

  const manifest = await ensureTemplates(log);
  const file = manifest.files["windows"];
  if (!file) {
    throw new TemplateError(
      `Release v${MIO_CLI_VERSION} has no Windows template. Build one locally with ` +
        `\`./scripts/build-templates.ps1 -Platform windows\`.`,
    );
  }
  const directory = join(cacheRoot(), stripArchiveSuffix(file.name));
  if (!(await exists(join(directory, "data")))) {
    throw new TemplateError(`Windows template is missing from the cache: ${directory}`);
  }
  const marker = join(directory, ".mio-template");
  const cached = (await exists(marker)) ? (await readFile(marker, "utf8")).trim() : "";
  if (cached !== file.sha256) {
    await rm(directory, { recursive: true, force: true });
    await fetchTemplates(log);
  }
  return { path: directory, source: "cache", version: manifest.templateVersion };
}

/** Template used by `mio dev`: prefer the universal build so emulators work too. */
export async function resolveDevAndroidTemplate(
  projectDir: string,
  config: MioConfig,
  options: TemplateOptions = {},
): Promise<ResolvedTemplate> {
  try {
    return await resolveAndroidTemplate(projectDir, config, options);
  } catch (error) {
    // Dev on an emulator needs the universal (or x64) build; if the configured
    // ABI is missing from the release, try universal before giving up.
    if (androidAbiOf(config) === "universal") throw error;
    return await resolveAndroidTemplate(
      projectDir,
      { ...config, android: { ...(config.android ?? {}), abi: "universal" } },
      options,
    );
  }
}

/** Human-readable summary for `mio doctor`. */
export async function describeTemplates(): Promise<string[]> {
  const lines: string[] = [];
  const root = cacheRoot();
  const manifest = await readManifest(root);
  if (!manifest) {
    lines.push(`templates: not cached (run \`mio build\` to download v${MIO_CLI_VERSION})`);
    return lines;
  }
  lines.push(
    `templates: v${manifest.templateVersion} (api ${manifest.apiVersion}) in ${root}`,
  );
  for (const [key, file] of Object.entries(manifest.files)) {
    const path = join(root, file.kind === "zip" ? stripArchiveSuffix(file.name) : file.name);
    lines.push(`  ${key}: ${(await exists(path)) ? "ok" : "missing"} (${formatBytes(file.size)})`);
  }
  return lines;
}

export type { LoadedConfig };
