import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Proxy used for release downloads.
 *
 * Order: standard env vars, then git's `http.proxy`. The git fallback matters on
 * machines where only git is configured to reach GitHub (which is exactly where
 * an un-proxied `fetch` dies with ECONNRESET).
 */
export function resolveProxy(): string | undefined {
  const env = process.env;
  const candidates = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.npm_config_https_proxy,
    env.npm_config_proxy,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  try {
    const result = spawnSync("git", ["config", "--get", "http.proxy"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    // git is optional; fall through to a direct connection.
  }
  return undefined;
}

/** Whether NO_PROXY excludes this host. */
export function shouldBypassProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === "*" || host === entry || host.endsWith(`.${entry}`));
}

function dispatcherFor(url: string): ProxyAgent | undefined {
  const proxy = resolveProxy();
  if (!proxy) return undefined;
  const host = new URL(url).hostname;
  if (shouldBypassProxy(host, process.env.NO_PROXY ?? process.env.no_proxy)) return undefined;
  return new ProxyAgent(proxy);
}

export interface DownloadOptions {
  proxy?: string;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return detail ? `${error.message} (${detail})` : error.message;
  }
  return String(error);
}

export class DownloadError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Could not download ${url}: ${describe(cause)}. ` +
        `If this machine cannot reach GitHub directly, set HTTPS_PROXY ` +
        `(or configure http.proxy in git) and retry.`,
    );
  }
}

export async function fetchText(url: string, options: DownloadOptions = {}): Promise<string> {
  const dispatcher = options.proxy ? new ProxyAgent(options.proxy) : dispatcherFor(url);
  try {
    const response = await undiciFetch(url, { redirect: "follow", dispatcher });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    throw new DownloadError(url, error);
  }
}

export async function fetchToFile(
  url: string,
  target: string,
  options: DownloadOptions = {},
): Promise<void> {
  const dispatcher = options.proxy ? new ProxyAgent(options.proxy) : dispatcherFor(url);
  const temporary = `${target}.part`;
  try {
    const response = await undiciFetch(url, { redirect: "follow", dispatcher });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
    await rm(target, { force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new DownloadError(url, error);
  }
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
