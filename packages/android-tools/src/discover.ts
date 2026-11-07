import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";

export type ToolSource = "env-bundle" | "android-sdk";

export interface AndroidTools {
  /** Java executable. Absolute path when known, otherwise "java" from PATH. */
  java: string;
  /** apksigner jar (contains com.android.apksigner.ApkSignerTool). */
  apksignerJar: string;
  /** zipalign executable. */
  zipalign: string;
  /** keytool executable, when available. */
  keytool?: string;
  /** Where the tools came from. */
  source: ToolSource;
  /** build-tools version, when source is android-sdk. */
  buildToolsVersion?: string;
  /** Android SDK root, when source is android-sdk. */
  sdkRoot?: string;
  /** JRE home, when the tools bundle contains one. */
  jreHome?: string;
}

/** What a machine currently has; every field is optional. */
export interface AndroidToolStatus {
  java?: string;
  jreHome?: string;
  keytool?: string;
  apksignerJar?: string;
  zipalign?: string;
  sdkRoot?: string;
  buildToolsVersion?: string;
  toolsSource?: ToolSource;
}

export function statusComplete(status: AndroidToolStatus): status is Required<
  Pick<AndroidToolStatus, "java" | "apksignerJar" | "zipalign">
> &
  AndroidToolStatus {
  return Boolean(status.java && status.apksignerJar && status.zipalign);
}

export function toolsFromStatus(status: AndroidToolStatus): AndroidTools {
  if (!statusComplete(status)) {
    throw new MioToolError(
      "ANDROID_TOOLS_NOT_FOUND",
      "Android build tools are incomplete",
      { details: describeMissing(status) },
    );
  }
  return {
    java: status.java,
    apksignerJar: status.apksignerJar,
    zipalign: status.zipalign,
    keytool: status.keytool,
    source: status.toolsSource ?? "android-sdk",
    buildToolsVersion: status.buildToolsVersion,
    sdkRoot: status.sdkRoot,
    jreHome: status.jreHome,
  };
}

export function describeMissing(status: AndroidToolStatus): string {
  const missing: string[] = [];
  if (!status.java) missing.push("java");
  if (!status.apksignerJar) missing.push("apksigner.jar");
  if (!status.zipalign) missing.push("zipalign");
  return missing.length === 0
    ? "nothing missing"
    : `missing: ${missing.join(", ")}`;
}

export interface DiscoverOptions {
  /** Override for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

const isWindows = (platform: NodeJS.Platform): boolean => platform === "win32";

const javaName = (platform: NodeJS.Platform): string =>
  isWindows(platform) ? "java.exe" : "java";

const keytoolName = (platform: NodeJS.Platform): string =>
  isWindows(platform) ? "keytool.exe" : "keytool";

const zipalignName = (platform: NodeJS.Platform): string =>
  isWindows(platform) ? "zipalign.exe" : "zipalign";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateSdkRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const roots: Array<string | undefined> = [
    env.MIO_ANDROID_SDK,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
  ];

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) roots.push(join(localAppData, "Android", "Sdk"));
  } else if (platform === "darwin") {
    roots.push(join(homedir(), "Library", "Android", "sdk"));
  } else {
    roots.push(join(homedir(), "Android", "Sdk"));
    roots.push(join(homedir(), "Android", "sdk"));
  }

  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

function compareVersions(a: string, b: string): number {
  const split = (value: string): number[] =>
    value.split(/[.-]/).map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });

  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function findJavaInHome(
  home: string | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (!home) return undefined;
  const candidate = join(home, "bin", javaName(platform));
  return (await exists(candidate)) ? candidate : undefined;
}

async function findJavaFromPath(platform: NodeJS.Platform): Promise<string | undefined> {
  // Let the OS resolve "java" from PATH. Validate it once so discovery fails
  // early with a useful error instead of at signing time.
  try {
    const result = await run("java", ["-version"], { timeoutMs: 10_000 });
    if (result.code === 0) return "java";
  } catch {
    // ignore
  }
  return undefined;
}

async function tryResolveJava(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  preferredHome?: string,
): Promise<{ java: string; jreHome?: string } | undefined> {
  const fromBundle = await findJavaInHome(preferredHome, platform);
  if (fromBundle) return { java: fromBundle, jreHome: preferredHome };

  const fromMioHome = await findJavaInHome(env.MIO_JAVA_HOME, platform);
  if (fromMioHome) return { java: fromMioHome, jreHome: env.MIO_JAVA_HOME };

  const fromJavaHome = await findJavaInHome(env.JAVA_HOME, platform);
  if (fromJavaHome) return { java: fromJavaHome, jreHome: env.JAVA_HOME };

  const fromPath = await findJavaFromPath(platform);
  if (fromPath) return { java: fromPath };

  return undefined;
}

async function resolveKeytool(
  java: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (java === "java") {
    try {
      const result = await run("keytool", ["-help"], { timeoutMs: 10_000 });
      if (result.code === 0) return "keytool";
    } catch {
      return undefined;
    }
    return undefined;
  }

  const candidate = join(dirname(java), keytoolName(platform));
  return (await exists(candidate)) ? candidate : undefined;
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function findBuildTools(
  sdkRoot: string,
  platform: NodeJS.Platform,
): Promise<{ dir: string; version: string } | undefined> {
  const buildToolsRoot = join(sdkRoot, "build-tools");
  let versions: string[];
  try {
    const entries = await readdir(buildToolsRoot, { withFileTypes: true });
    versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return undefined;
  }

  for (const version of versions) {
    const dir = join(buildToolsRoot, version);
    const apksignerJar = await firstExisting([
      join(dir, "lib", "apksigner.jar"),
      join(dir, "apksigner.jar"),
    ]);
    const zipalign = await firstExisting([
      join(dir, zipalignName(platform)),
      join(dir, "bin", zipalignName(platform)),
    ]);
    if (apksignerJar && zipalign) {
      return { dir, version };
    }
  }

  return undefined;
}

/**
 * Inspect what the machine has without throwing.
 *
 * Tools come from `MIO_ANDROID_TOOLS_DIR` first (a Mio bundle) and then the
 * Android SDK build-tools; Java from the bundle's `jre/`, `MIO_JAVA_HOME`,
 * `JAVA_HOME`, or `PATH`. A partial result is normal: a machine may have Java
 * but no build-tools, or the other way round.
 */
export async function inspectAndroidTools(
  options: DiscoverOptions = {},
): Promise<AndroidToolStatus> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const status: AndroidToolStatus = {};

  const toolsDir = env.MIO_ANDROID_TOOLS_DIR;
  if (toolsDir) {
    status.apksignerJar = await firstExisting([
      join(toolsDir, "apksigner.jar"),
      join(toolsDir, "lib", "apksigner.jar"),
    ]);
    status.zipalign = await firstExisting([
      join(toolsDir, zipalignName(platform)),
      join(toolsDir, "bin", zipalignName(platform)),
    ]);
    if (status.apksignerJar && status.zipalign) status.toolsSource = "env-bundle";

    const jreHome = join(toolsDir, "jre");
    if (await exists(join(jreHome, "bin", javaName(platform)))) {
      status.jreHome = jreHome;
    }
  }

  if (!status.apksignerJar || !status.zipalign) {
    for (const root of candidateSdkRoots(env, platform)) {
      if (!(await exists(root))) continue;
      const match = await findBuildTools(root, platform);
      if (!match) continue;
      status.apksignerJar = await firstExisting([
        join(match.dir, "lib", "apksigner.jar"),
        join(match.dir, "apksigner.jar"),
      ]);
      status.zipalign = await firstExisting([
        join(match.dir, zipalignName(platform)),
        join(match.dir, "bin", zipalignName(platform)),
      ]);
      if (status.apksignerJar && status.zipalign) {
        status.toolsSource = "android-sdk";
        status.sdkRoot = root;
        status.buildToolsVersion = match.version;
        break;
      }
    }
  }

  const java = await tryResolveJava(env, platform, status.jreHome);
  if (java) {
    status.java = java.java;
    status.jreHome = java.jreHome ?? status.jreHome;
    status.keytool = await resolveKeytool(java.java, platform);
  }

  return status;
}

/**
 * Find a usable Android signing toolchain.
 *
 * Priority:
 * 1. MIO_ANDROID_TOOLS_DIR (a downloaded/bundled toolchain)
 * 2. ANDROID_HOME / ANDROID_SDK_ROOT / default SDK locations
 *
 * Throws with a message that says exactly what is missing.
 */
export async function discoverAndroidTools(
  options: DiscoverOptions = {},
): Promise<AndroidTools> {
  const status = await inspectAndroidTools(options);
  if (!status.java) {
    throw new MioToolError(
      "JAVA_NOT_FOUND",
      "Java was not found. Install a JDK/JRE 17+ or let Mio download one.",
      {
        details:
          "Set MIO_JAVA_HOME/JAVA_HOME, put java on PATH, or set MIO_ANDROID_TOOLS_DIR to a tools bundle containing jre/.",
      },
    );
  }
  if (!status.apksignerJar || !status.zipalign) {
    throw new MioToolError(
      "ANDROID_TOOLS_NOT_FOUND",
      "Android build-tools (apksigner + zipalign) were not found.",
      {
        details:
          "Set ANDROID_HOME (or MIO_ANDROID_SDK), install Android build-tools 35+, or point MIO_ANDROID_TOOLS_DIR at a Mio tools bundle.",
      },
    );
  }
  return toolsFromStatus(status);
}

export function describeAndroidTools(tools: AndroidTools): string {
  const source =
    tools.source === "android-sdk"
      ? `Android SDK build-tools ${tools.buildToolsVersion ?? "?"}`
      : "Mio tools bundle";
  return [
    `source: ${source}`,
    `java: ${tools.java}`,
    `apksigner: ${tools.apksignerJar}`,
    `zipalign: ${tools.zipalign}`,
    tools.keytool ? `keytool: ${tools.keytool}` : "keytool: not found",
  ].join("\n");
}
