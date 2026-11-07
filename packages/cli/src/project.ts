import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

export const cliRoot = fileURLToPath(new URL("..", import.meta.url));
export const repoRoot = resolve(cliRoot, "..", "..");

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mio-app";
}

export function safePackageName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `mio-${cleaned || "app"}`;
}

export async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      return name !== "node_modules" && name !== ".mio" && name !== "dist";
    },
  });
}

export function packageVersion(manifest: { version: string }): string {
  return manifest.version;
}

export async function findFirstExe(directory: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const exe = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"));
  return exe ? join(directory, exe.name) : undefined;
}
