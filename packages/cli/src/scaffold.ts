import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MIO_API_PACKAGE, MIO_API_PACKAGE_VERSION, MIO_CLI_VERSION } from "./constants.js";
import {
  cliRoot,
  copyDirectory,
  exists,
  repoRoot,
  safePackageName,
  writeJson,
} from "./project.js";

export interface ProjectPackage {
  name?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface InitResult {
  target: string;
  created: boolean;
  changes: string[];
  packageCreated: boolean;
}

const CLI_PACKAGE = "@iyexin/mio-cli";

const SCRIPTS: Record<string, string> = {
  dev: "mio dev --platform windows",
  "dev:web": "vite",
  "dev:android": "mio dev --platform android",
  "build:windows": "mio build --platform windows",
  "build:android": "mio build --platform android",
};

const GITIGNORE_LINES = [
  "node_modules/",
  "dist/",
  "build/",
  "artifacts/",
  ".cache/",
  ".mio/*.p12",
  "*.log",
];

/**
 * Adds the Mio entries a project needs, without touching anything it already
 * defines: existing scripts, dependencies and unknown fields are preserved.
 */
export function mergeProjectPackage(
  pkg: ProjectPackage,
  options: { apiVersion?: string; cliVersion?: string } = {},
): { value: ProjectPackage; changes: string[] } {
  const apiVersion = options.apiVersion ?? MIO_API_PACKAGE_VERSION;
  const cliVersion = options.cliVersion ?? MIO_CLI_VERSION;
  const value = JSON.parse(JSON.stringify(pkg)) as ProjectPackage;
  const changes: string[] = [];

  const scripts = { ...(value.scripts ?? {}) };
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (!(name in scripts)) {
      scripts[name] = command;
      changes.push(`scripts.${name}`);
    }
  }
  if (changes.length > 0) value.scripts = scripts;

  const dependencies = { ...(value.dependencies ?? {}) };
  if (!(MIO_API_PACKAGE in dependencies)) {
    dependencies[MIO_API_PACKAGE] = `^${apiVersion}`;
    changes.push(`dependencies.${MIO_API_PACKAGE}`);
  }
  if (changes.some((change) => change.startsWith("dependencies."))) {
    value.dependencies = dependencies;
  }

  const devDependencies = { ...(value.devDependencies ?? {}) };
  if (!(CLI_PACKAGE in devDependencies)) {
    devDependencies[CLI_PACKAGE] = `^${cliVersion}`;
    changes.push(`devDependencies.${CLI_PACKAGE}`);
  }
  if (changes.some((change) => change.startsWith("devDependencies."))) {
    value.devDependencies = devDependencies;
  }

  return { value, changes };
}

/** Appends only the missing ignore rules; the existing file is never rewritten. */
export function mergeGitignore(existing: string): { value: string; added: string[] } {
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((line) => line.trim()));
  const added = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (added.length === 0) return { value: existing, added: [] };
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return { value: `${base}${added.join("\n")}\n`, added };
}

/** Rewrites the Mio packages a project depends on to `^<version>`. */
export function upgradePackageJson(
  pkg: ProjectPackage,
  version: string,
): { value: ProjectPackage; changes: Array<{ name: string; from: string; to: string }> } {
  const value = JSON.parse(JSON.stringify(pkg)) as ProjectPackage;
  const changes: Array<{ name: string; from: string; to: string }> = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const map = value[field];
    if (!map) continue;
    for (const [name, range] of Object.entries(map)) {
      if (!name.startsWith("@iyexin/mio-")) continue;
      const next = `^${version}`;
      if (range === next) continue;
      map[name] = next;
      changes.push({ name, from: range, to: next });
    }
  }
  return { value, changes };
}

export function normalizeVersion(input: string): string {
  const value = input.trim().replace(/^[~^]/, "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid version: ${input} (expected x.y.z)`);
  }
  return value;
}

async function templateDir(): Promise<string> {
  const candidates = [join(cliRoot, "templates", "web"), join(repoRoot, "templates", "web")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Template not found. Looked in:\n${candidates.join("\n")}`);
}

function defaultConfig(template: Record<string, unknown>, name: string, hasIcon: boolean): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(template)) as {
    app: { id: string; name: string; icon?: string };
    android?: Record<string, unknown>;
  };
  config.app.id = `dev.mio.${name.replaceAll("-", "_")}`;
  config.app.name = name;
  if (!hasIcon) delete config.app.icon;
  if (config.android) delete config.android.template;
  return config as Record<string, unknown>;
}

async function writeGitignore(target: string, existing: string | undefined): Promise<string[]> {
  const path = join(target, ".gitignore");
  const { value, added } = mergeGitignore(existing ?? "");
  if (added.length > 0 || existing === undefined) await writeFile(path, value, "utf8");
  return added;
}

/** Full scaffold into an empty (or missing) directory. */
export async function scaffoldProject(target: string): Promise<InitResult> {
  const template = await templateDir();
  await copyDirectory(template, target);
  await mkdir(join(target, "src"), { recursive: true });

  const projectName = safePackageName(basename(target));
  const packagePath = join(target, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as ProjectPackage;
  pkg.name = projectName;
  pkg.private = true;
  // The template's own values are placeholders: a fresh scaffold owns them.
  pkg.scripts = { ...(pkg.scripts ?? {}), ...SCRIPTS };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [MIO_API_PACKAGE]: `^${MIO_API_PACKAGE_VERSION}` };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [CLI_PACKAGE]: `^${MIO_CLI_VERSION}` };
  await writeJson(packagePath, pkg);

  const templateConfig = JSON.parse(
    await readFile(join(template, "mio.config.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeJson(
    join(target, "mio.config.json"),
    defaultConfig(templateConfig, basename(target), await exists(join(target, "icon.png"))),
  );

  const added = await writeGitignore(target, undefined);
  return {
    target,
    created: true,
    changes: ["package.json", "mio.config.json", ...added.map((line) => `.gitignore:${line}`)],
    packageCreated: true,
  };
}

/**
 * Initializes Mio inside an existing project.
 *
 * Only missing pieces are added: `package.json` keeps its own scripts and
 * dependencies, `mio.config.json` is never overwritten, and running it twice
 * is a no-op.
 */
export async function initProject(target: string): Promise<InitResult> {
  const info = await exists(target).then(async (ok) => (ok ? stat(target) : undefined));
  if (info && !info.isDirectory()) throw new Error(`Target is not a directory: ${target}`);
  if (!info) {
    await mkdir(target, { recursive: true });
    return scaffoldProject(target);
  }
  if ((await readdir(target)).length === 0) return scaffoldProject(target);

  const changes: string[] = [];
  const packagePath = join(target, "package.json");
  const packageCreated = !(await exists(packagePath));
  const pkg = packageCreated
    ? ({} as ProjectPackage)
    : (JSON.parse(await readFile(packagePath, "utf8")) as ProjectPackage);

  const projectName = safePackageName(basename(target));
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    pkg.name = pkg.name ?? projectName;
    changes.push("name");
  }
  const merged = mergeProjectPackage(pkg);
  if (merged.changes.length > 0 || packageCreated) {
    await writeJson(packagePath, merged.value);
    changes.push(...merged.changes);
  }

  const configPath = join(target, "mio.config.json");
  if (!(await exists(configPath))) {
    const templateConfig = JSON.parse(
      await readFile(join(await templateDir(), "mio.config.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeJson(
      configPath,
      defaultConfig(templateConfig, basename(target), await exists(join(target, "icon.png"))),
    );
    changes.push("mio.config.json");
  }

  const gitignorePath = join(target, ".gitignore");
  const gitignore = (await exists(gitignorePath))
    ? await readFile(gitignorePath, "utf8")
    : undefined;
  const added = await writeGitignore(target, gitignore);
  changes.push(...added.map((line) => `.gitignore:${line}`));

  return { target, created: false, changes, packageCreated };
}

export interface UpgradeResult {
  target: string;
  version: string;
  changes: Array<{ name: string; from: string; to: string }>;
}

/** Updates every `@iyexin/mio-*` dependency the project already declares. */
export async function upgradeProject(target: string, version?: string): Promise<UpgradeResult> {
  const packagePath = join(resolve(target), "package.json");
  if (!(await exists(packagePath))) {
    throw new Error(`No package.json in ${resolve(target)}; run \`mio init\` first`);
  }
  const wanted = normalizeVersion(version ?? MIO_CLI_VERSION);
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as ProjectPackage;
  const { value, changes } = upgradePackageJson(pkg, wanted);
  if (changes.length > 0) await writeJson(packagePath, value);
  return { target: resolve(target), version: wanted, changes };
}
