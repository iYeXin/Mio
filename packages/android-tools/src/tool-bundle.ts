import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { MioToolError } from "./errors.js";

/**
 * A tool bundle ships two independently downloadable components:
 *
 * - `tools`: apksigner.jar + zipalign[.exe] (~1.5 MB)
 * - `jre`:   a jlink-trimmed Java runtime with java.base + java.logging (~18 MB)
 *
 * A machine that already has Java only needs `tools`, and one that has the
 * Android build-tools only needs `jre`. The installer never re-downloads a
 * component whose digest still matches.
 */

export interface ToolBundleComponent {
  /** Archive URL (http:, https:, or file:). */
  url: string;
  /** SHA-256 of the archive. */
  sha256: string;
  /** Optional expected archive size in bytes. */
  size?: number;
  /** Number of leading path segments to strip during extraction. Default: 1. */
  strip?: number;
}

export interface ToolBundlePlatform {
  tools?: ToolBundleComponent;
  jre?: ToolBundleComponent;
}

export interface ToolBundleManifest {
  schemaVersion: 2;
  latest: string;
  bundles: Record<string, { platforms: Record<string, ToolBundlePlatform> }>;
}

export type ToolComponent = "tools" | "jre";

export interface InstallToolBundleOptions {
  /** Manifest object, local path, or http(s)/file URL. */
  manifest: ToolBundleManifest | string;
  /** Defaults to manifest.latest. */
  version?: string;
  /** Defaults to `${process.platform}-${process.arch}`. */
  platform?: string;
  /** Defaults to ~/.mio/tools/android. */
  cacheDir?: string;
  /** Defaults to HTTPS_PROXY/HTTP_PROXY/ALL_PROXY. */
  proxy?: string;
  /** Re-download even if a cached bundle exists. */
  force?: boolean;
  /** Which components to install. Defaults to both. */
  components?: ToolComponent[];
  log?: (message: string) => void;
}

export interface InstalledToolBundle {
  dir: string;
  version: string;
  platform: string;
  installed: ToolComponent[];
}

interface CacheMarker {
  version: string;
  platform: string;
  components: Partial<Record<ToolComponent, string>>;
  installedAt: string;
}

const MARKER_FILE = ".mio-tools.json";

export function platformKeyOf(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

function defaultCacheDir(): string {
  return join(homedir(), ".mio", "tools", "android");
}

function defaultProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchBuffer(url: string, proxy: string | undefined): Promise<Buffer> {
  if (url.startsWith("file:")) {
    return await readFile(fileURLToPath(url));
  }

  const init: Parameters<typeof undiciFetch>[1] = {};
  if (proxy) init.dispatcher = new ProxyAgent(proxy);

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, init);
  } catch (error) {
    throw new MioToolError("BUNDLE_DOWNLOAD_FAILED", `Failed to download ${url}`, {
      cause: error,
      details: proxy ? `proxy: ${proxy}` : undefined,
    });
  }
  if (!response.ok) {
    throw new MioToolError(
      "BUNDLE_DOWNLOAD_FAILED",
      `Failed to download ${url}: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function loadManifest(
  source: ToolBundleManifest | string,
  proxy: string | undefined,
): Promise<ToolBundleManifest> {
  if (typeof source !== "string") return source;

  const buffer =
    source.startsWith("http:") || source.startsWith("https:") || source.startsWith("file:")
      ? await fetchBuffer(source, proxy)
      : await readFile(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new MioToolError("BUNDLE_DOWNLOAD_FAILED", "Tool bundle manifest is not valid JSON", {
      cause: error,
    });
  }

  const manifest = parsed as Partial<ToolBundleManifest>;
  if (manifest.schemaVersion !== 2 || typeof manifest.latest !== "string" || !manifest.bundles) {
    throw new MioToolError("BUNDLE_DOWNLOAD_FAILED", "Unsupported tool bundle manifest");
  }
  return manifest as ToolBundleManifest;
}

function selectPlatform(
  manifest: ToolBundleManifest,
  version: string,
  platform: string,
): ToolBundlePlatform {
  const bundle = manifest.bundles[version];
  if (!bundle) {
    throw new MioToolError("BUNDLE_DOWNLOAD_FAILED", `Unknown tool bundle version: ${version}`);
  }
  const entry = bundle.platforms[platform];
  if (!entry) {
    throw new MioToolError(
      "BUNDLE_DOWNLOAD_FAILED",
      `Tool bundle ${version} has no build for ${platform}`,
      { details: `available: ${Object.keys(bundle.platforms).join(", ")}` },
    );
  }
  return entry;
}

async function readMarker(path: string): Promise<CacheMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheMarker>;
    if (typeof parsed.version !== "string" || typeof parsed.platform !== "string") return undefined;
    return {
      version: parsed.version,
      platform: parsed.platform,
      components: parsed.components ?? {},
      installedAt: parsed.installedAt ?? "",
    };
  } catch {
    return undefined;
  }
}

async function componentPresent(dir: string, component: ToolComponent): Promise<boolean> {
  if (component === "tools") {
    const jar = [join(dir, "apksigner.jar"), join(dir, "lib", "apksigner.jar")];
    const align =
      process.platform === "win32"
        ? [join(dir, "zipalign.exe"), join(dir, "bin", "zipalign.exe")]
        : [join(dir, "zipalign"), join(dir, "bin", "zipalign")];
    return (await anyExists(jar)) && (await anyExists(align));
  }
  const java = process.platform === "win32" ? "java.exe" : "java";
  return await exists(join(dir, "jre", "bin", java));
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (await exists(path)) return true;
  }
  return false;
}

async function extractComponent(
  entry: ToolBundleComponent,
  proxy: string | undefined,
  target: string,
): Promise<void> {
  const tempRoot = await mkdtemp(join(target, "..", ".download-"));
  const archivePath = join(tempRoot, "component.tar.gz");
  const extractDir = join(tempRoot, "extracted");
  try {
    await mkdir(extractDir, { recursive: true });
    const archive = await fetchBuffer(entry.url, proxy);
    if (entry.size !== undefined && archive.length !== entry.size) {
      throw new MioToolError(
        "BUNDLE_CHECKSUM_FAILED",
        `Tool bundle size mismatch: expected ${entry.size}, got ${archive.length}`,
      );
    }
    const digest = sha256(archive);
    if (digest !== entry.sha256.toLowerCase()) {
      throw new MioToolError(
        "BUNDLE_CHECKSUM_FAILED",
        `Tool bundle SHA-256 mismatch: expected ${entry.sha256}, got ${digest}`,
      );
    }

    await writeFile(archivePath, archive);
    await tar.x({
      file: archivePath,
      cwd: extractDir,
      strip: entry.strip ?? 1,
      strict: true,
      preservePaths: false,
    });

    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await rename(extractDir, target);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Download, verify and cache the requested components of a tool bundle.
 *
 * Components whose cached digest still matches are kept; only the missing ones
 * are fetched. Pass `force` to reinstall everything.
 */
export async function installToolBundle(
  options: InstallToolBundleOptions,
): Promise<InstalledToolBundle> {
  const log = options.log ?? (() => {});
  const proxy = options.proxy ?? defaultProxy();
  const manifest = await loadManifest(options.manifest, proxy);
  const version = options.version ?? manifest.latest;
  const platform = options.platform ?? platformKeyOf(process.platform, process.arch);
  const entry = selectPlatform(manifest, version, platform);
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const dest = join(cacheDir, version, platform);
  const requested = options.components ?? (["tools", "jre"] as ToolComponent[]);

  await mkdir(dest, { recursive: true });
  const markerPath = join(dest, MARKER_FILE);
  const marker = options.force ? undefined : await readMarker(markerPath);
  const components: Partial<Record<ToolComponent, string>> = {};
  const installed: ToolComponent[] = [];

  for (const component of requested) {
    const source = entry[component];
    if (!source) {
      throw new MioToolError(
        "BUNDLE_DOWNLOAD_FAILED",
        `Tool bundle ${version} has no "${component}" component for ${platform}`,
      );
    }

    const cachedDigest = marker?.components[component];
    const present = await componentPresent(dest, component);
    if (
      !options.force &&
      cachedDigest === source.sha256.toLowerCase() &&
      present
    ) {
      components[component] = cachedDigest;
      log(`${component}: cached`);
      continue;
    }

    const target = component === "tools" ? join(dest, "tools-root") : join(dest, "jre");
    log(`downloading ${component} (${source.url})`);
    await extractComponent(source, proxy, target);

    if (component === "tools") {
      // Move everything (binary, jar, lib64/) into the bundle root so the
      // zipalign binary keeps its shared libraries next to it.
      for (const name of await readdir(target)) {
        const from = join(target, name);
        const to = join(dest, name);
        await rm(to, { recursive: true, force: true });
        await rename(from, to);
      }
      await rm(target, { recursive: true, force: true });
    }

    if (!(await componentPresent(dest, component))) {
      throw new MioToolError(
        "BUNDLE_EXTRACT_FAILED",
        `Tool bundle is missing files for "${component}"`,
      );
    }

    components[component] = source.sha256.toLowerCase();
    installed.push(component);
  }

  const now = new Date().toISOString();
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        version,
        platform,
        components: { ...(marker?.components ?? {}), ...components },
        installedAt: now,
      } satisfies CacheMarker,
      null,
      2,
    ),
  );

  return { dir: dest, version, platform, installed };
}
