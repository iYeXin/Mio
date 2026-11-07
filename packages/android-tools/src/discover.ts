import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";

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
  source: "env-bundle" | "android-sdk";
  /** build-tools version, when source is android-sdk. */
  buildToolsVersion?: string;
  /** Android SDK root, when source is android-sdk. */
  sdkRoot?: string;
  /** JRE home, when the tools bundle contains one. */
  jreHome?: string;
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

async function resolveJava(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  preferredHome?: string,
): Promise<{ java: string; jreHome?: string }> {
  const fromBundle = await findJavaInHome(preferredHome, platform);
  if (fromBundle) {
    return { java: fromBundle, jreHome: preferredHome };
  }

  const fromMioHome = await findJavaInHome(env.MIO_JAVA_HOME, platform);
  if (fromMioHome) {
    return { java: fromMioHome, jreHome: env.MIO_JAVA_HOME };
  }

  const fromJavaHome = await findJavaInHome(env.JAVA_HOME, platform);
  if (fromJavaHome) {
    return { java: fromJavaHome, jreHome: env.JAVA_HOME };
  }

  const fromPath = await findJavaFromPath(platform);
  if (fromPath) {
    return { java: fromPath };
  }

  throw new MioToolError(
    "JAVA_NOT_FOUND",
    "Java was not found. Install a JDK/JRE 17+ or place a JRE at <tools>/jre.",
    {
      details:
        "Set MIO_JAVA_HOME/JAVA_HOME, put java on PATH, or point MIO_ANDROID_TOOLS_DIR at a tools bundle containing jre/.",
    },
  );
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

async function fromToolsDir(
  dir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<AndroidTools> {
  const apksignerCandidates = [
    join(dir, "apksigner.jar"),
    join(dir, "lib", "apksigner.jar"),
  ];
  const zipalignCandidates = [
    join(dir, zipalignName(platform)),
    join(dir, "bin", zipalignName(platform)),
  ];

  const apksignerJar = await firstExisting(apksignerCandidates);
  const zipalign = await firstExisting(zipalignCandidates);

  if (!apksignerJar || !zipalign) {
    throw new MioToolError(
      "INVALID_TOOLS_DIR",
      `MIO_ANDROID_TOOLS_DIR does not look like an Android tools bundle: ${dir}`,
      {
        details:
          "Expected apksigner.jar (or lib/apksigner.jar), zipalign, and optionally jre/.",
      },
    );
  }

  const jreHomeCandidate = join(dir, "jre");
  const jreHome = (await exists(join(jreHomeCandidate, "bin", javaName(platform))))
    ? jreHomeCandidate
    : undefined;
  const { java, jreHome: resolvedJreHome } = await resolveJava(env, platform, jreHome);
  const keytool = await resolveKeytool(java, platform);

  return {
    java,
    apksignerJar,
    zipalign,
    keytool,
    source: "env-bundle",
    jreHome: resolvedJreHome,
  };
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

interface BuildToolsMatch {
  dir: string;
  version: string;
}

async function findBuildTools(
  sdkRoot: string,
  platform: NodeJS.Platform,
): Promise<BuildToolsMatch | undefined> {
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

async function fromAndroidSdk(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<AndroidTools> {
  const roots = candidateSdkRoots(env, platform);
  for (const sdkRoot of roots) {
    if (!(await exists(sdkRoot))) continue;
    const match = await findBuildTools(sdkRoot, platform);
    if (!match) continue;

    const apksignerJar = await firstExisting([
      join(match.dir, "lib", "apksigner.jar"),
      join(match.dir, "apksigner.jar"),
    ]);
    const zipalign = await firstExisting([
      join(match.dir, zipalignName(platform)),
      join(match.dir, "bin", zipalignName(platform)),
    ]);
    if (!apksignerJar || !zipalign) continue;

    const { java, jreHome } = await resolveJava(env, platform);
    const keytool = await resolveKeytool(java, platform);

    return {
      java,
      apksignerJar,
      zipalign,
      keytool,
      source: "android-sdk",
      buildToolsVersion: match.version,
      sdkRoot,
      jreHome,
    };
  }

  throw new MioToolError(
    "ANDROID_TOOLS_NOT_FOUND",
    "Android build-tools (apksigner + zipalign) were not found.",
    {
      details:
        "Set ANDROID_HOME (or MIO_ANDROID_SDK), install Android build-tools 35+, or point MIO_ANDROID_TOOLS_DIR at a Mio tools bundle.",
    },
  );
}

/**
 * Find a usable Android signing toolchain.
 *
 * Priority:
 * 1. MIO_ANDROID_TOOLS_DIR (a downloaded/bundled toolchain)
 * 2. ANDROID_HOME / ANDROID_SDK_ROOT / default SDK locations
 */
export async function discoverAndroidTools(
  options: DiscoverOptions = {},
): Promise<AndroidTools> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (env.MIO_ANDROID_TOOLS_DIR) {
    return await fromToolsDir(env.MIO_ANDROID_TOOLS_DIR, env, platform);
  }

  return await fromAndroidSdk(env, platform);
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
