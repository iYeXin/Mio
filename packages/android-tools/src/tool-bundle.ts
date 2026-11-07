import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { discoverAndroidTools, type AndroidTools } from "./discover.js";
import { MioToolError } from "./errors.js";

export interface ToolBundlePlatform {
  /** Archive URL (http:, https:, or file:). */
  url: string;
  /** SHA-256 of the archive. */
  sha256: string;
  /** Optional expected archive size in bytes. */
  size?: number;
  /** Number of leading path segments to strip during extraction. Default: 1. */
  strip?: number;
}

export interface ToolBundleManifest {
  schemaVersion: 1;
  latest: string;
  bundles: Record<
    string,
    {
      platforms: Record<string, ToolBundlePlatform>;
    }
  >;
}

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
}

export interface InstalledToolBundle {
  tools: AndroidTools;
  dir: string;
  version: string;
  platform: string;
}

interface CacheMarker {
  version: string;
  platform: string;
  sha256: string;
  installedAt: string;
}

const MANIFEST_FILE = ".mio-tools.json";

function platformKeyOf(platform: NodeJS.Platform, arch: string): string {
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
  if (proxy) {
    init.dispatcher = new ProxyAgent(proxy);
  }

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
  if (manifest.schemaVersion !== 1 || typeof manifest.latest !== "string" || !manifest.bundles) {
    throw new MioToolError("BUNDLE_DOWNLOAD_FAILED", "Unsupported tool bundle manifest");
  }
  return manifest as ToolBundleManifest;
}

function selectBundle(
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
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.platform !== "string" ||
      typeof parsed.sha256 !== "string"
    ) {
      return undefined;
    }
    return {
      version: parsed.version,
      platform: parsed.platform,
      sha256: parsed.sha256,
      installedAt: parsed.installedAt ?? "",
    };
  } catch {
    return undefined;
  }
}

async function validateBundleLayout(dir: string): Promise<void> {
  const apksigner = [join(dir, "apksigner.jar"), join(dir, "lib", "apksigner.jar")];
  const zipalign =
    process.platform === "win32"
      ? [join(dir, "zipalign.exe"), join(dir, "bin", "zipalign.exe")]
      : [join(dir, "zipalign"), join(dir, "bin", "zipalign")];

  for (const candidate of apksigner) {
    if (await exists(candidate)) break;
    if (candidate === apksigner[apksigner.length - 1]) {
      throw new MioToolError("BUNDLE_EXTRACT_FAILED", "Tool bundle is missing apksigner.jar");
    }
  }
  for (const candidate of zipalign) {
    if (await exists(candidate)) break;
    if (candidate === zipalign[zipalign.length - 1]) {
      throw new MioToolError("BUNDLE_EXTRACT_FAILED", "Tool bundle is missing zipalign");
    }
  }
}

/**
 * Download, verify, extract, and cache a Mio Android tools bundle.
 *
 * The bundle is a .tar.gz containing apksigner.jar, zipalign[.exe], and
 * optionally jre/. The archive is authenticated by SHA-256 before extraction.
 */
export async function installToolBundle(
  options: InstallToolBundleOptions,
): Promise<InstalledToolBundle> {
  const proxy = options.proxy ?? defaultProxy();
  const manifest = await loadManifest(options.manifest, proxy);
  const version = options.version ?? manifest.latest;
  const platform = options.platform ?? platformKeyOf(process.platform, process.arch);
  const entry = selectBundle(manifest, version, platform);

  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const dest = join(cacheDir, version, platform);
  const markerPath = join(dest, MANIFEST_FILE);

  await mkdir(cacheDir, { recursive: true });

  if (!options.force) {
    const marker = await readMarker(markerPath);
    if (marker?.sha256 === entry.sha256 && (await exists(dest))) {
      try {
        const tools = await discoverAndroidTools({
          env: { ...process.env, MIO_ANDROID_TOOLS_DIR: dest },
        });
        return { tools, dir: dest, version, platform };
      } catch {
        // Cached bundle is incomplete or corrupt; fall through and reinstall.
        await rm(dest, { recursive: true, force: true });
      }
    }
  }

  const tempRoot = await mkdtemp(join(cacheDir, ".download-"));
  const archivePath = join(tempRoot, "tools.tar.gz");
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

    await validateBundleLayout(extractDir);

    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await rename(extractDir, dest);
    await writeFile(
      markerPath,
      JSON.stringify(
        {
          version,
          platform,
          sha256: entry.sha256,
          installedAt: new Date().toISOString(),
        } satisfies CacheMarker,
        null,
        2,
      ),
    );

    const tools = await discoverAndroidTools({
      env: { ...process.env, MIO_ANDROID_TOOLS_DIR: dest },
    });
    return { tools, dir: dest, version, platform };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export { platformKeyOf };
