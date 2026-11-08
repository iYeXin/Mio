import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildAppBundle,
  ensureAndroidTools,
  ensureDebugKeystore,
  injectApk,
  signApk,
  type AndroidTools,
} from "@iyexin/mio-android-tools";
import type { LoadedConfig } from "./config.js";
import { createAppAsar } from "./asar.js";
import { resolveAndroidTemplate } from "./templates.js";
import { ensureWebBuild } from "./web.js";
import { safeName } from "./project.js";
import { MIO_CLI_VERSION, MIO_RELEASE_BASE } from "./constants.js";
import { resolveProxy } from "./download.js";

export type AndroidFormat = "apk" | "aab";

export interface BuildAndroidOptions {
  loaded: LoadedConfig;
  skipWeb: boolean;
  /** Overrides the resolved template path (--template). */
  template?: string;
  /** `aab` produces a Play upload bundle; defaults to `apk`. */
  format?: AndroidFormat;
}

export interface BuildAndroidResult {
  output: string;
  size: number;
  verified: boolean;
  format: AndroidFormat;
}

export async function buildAndroid(options: BuildAndroidOptions): Promise<BuildAndroidResult> {
  const { config, projectDir } = options.loaded;
  const format = options.format ?? "apk";
  const webDir = await ensureWebBuild(projectDir, config, options.skipWeb);
  // A bundle is split by Play per ABI, so it must be built from the universal
  // template regardless of `android.abi`.
  const template = await resolveAndroidTemplate(projectDir, config, {
    explicit: options.template,
    abi: format === "aab" ? "universal" : undefined,
    log: (message) => console.error(message),
  });
  // Missing Java or build-tools are fetched on demand; existing ones are reused.
  const resolved = await ensureAndroidTools({
    manifest:
      process.env.MIO_TOOLS_MANIFEST_URL ??
      `${MIO_RELEASE_BASE}/v${MIO_CLI_VERSION}/mio-tools.json`,
    allowDownload: process.env.MIO_NO_TOOL_DOWNLOAD !== "1",
    force: process.env.MIO_TOOLS_FORCE_DOWNLOAD === "1",
    cacheDir: process.env.MIO_TOOLS_CACHE_DIR,
    proxy: resolveProxy(),
    needBundle: format === "aab",
    log: (message) => console.error(`[tools] ${message}`),
  });
  const tools = resolved.tools;

  const temp = await mkdtemp(join(tmpdir(), "mio-android-build-"));
  const asarPath = join(temp, "app.asar");
  const unsigned = join(temp, "app-unsigned.apk");
  const outputDir = resolve(projectDir, "build", "mio", "android");
  const extension = format === "aab" ? "aab" : "apk";
  const output = join(outputDir, `${safeName(config.app.name)}-${config.app.version}.${extension}`);

  try {
    const asar = await createAppAsar({ webDir, output: asarPath, config });

    await injectApk({
      templateApk: template.path,
      asar: asarPath,
      output: unsigned,
      manifest: {
        packageName: config.app.id,
        versionCode: versionCode(config.app.version),
        versionName: config.app.version,
        appName: config.app.name,
      },
      icon: config.app.icon ? resolve(projectDir, config.app.icon) : undefined,
    });

    if (format === "aab") {
      // Play rejects bundles signed with a throwaway key; the upload key is the
      // project's release keystore, and jarsigner reads the password from env.
      if (!config.android?.keystore) {
        throw new Error(
          "AAB builds need a release keystore: set android.keystore, android.alias and android.storePasswordEnv in mio.config.json (see `mio keystore`).",
        );
      }
      const signing = await resolveReleaseSigning(options.loaded);
      const bundle = await buildAppBundle({
        apk: unsigned,
        output,
        tools,
        workDir: temp,
        keystore: signing.keystore,
        alias: signing.alias,
        storePasswordEnv: signing.storePasswordEnv,
        keyPasswordEnv: config.android.keyPasswordEnv,
        log: (message) => console.error(`[aab] ${message}`),
      });
      return { output: bundle.output, size: bundle.size, verified: bundle.verified, format };
    }

    const signing = await resolveSigning(options.loaded, tools);
    const signed = await signApk({
      tools,
      input: unsigned,
      output,
      keystore: signing.keystore,
      keystorePassword: signing.password,
      keyAlias: signing.alias,
      keyPassword: signing.keyPassword,
      minSdkVersion: config.android?.minSdk ?? 24,
      pageSize: config.android?.pageSize ?? 16,
    });

    const info = await stat(output);
    return {
      output,
      size: info.size,
      verified: signed.verify.verified,
      format,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

interface ReleaseSigning {
  keystore: string;
  alias: string;
  storePasswordEnv: string;
}

function resolveReleaseSigning(loaded: LoadedConfig): ReleaseSigning {
  const { config, projectDir } = loaded;
  if (!config.android?.keystore) {
    throw new Error("android.keystore is not configured");
  }
  const storePasswordEnv = config.android.storePasswordEnv ?? "MIO_KS_PASS";
  if (!process.env[storePasswordEnv]) {
    throw new Error(`Release keystore password is missing: set ${storePasswordEnv}`);
  }
  return {
    keystore: resolve(projectDir, config.android.keystore),
    alias: config.android.alias ?? "release",
    storePasswordEnv,
  };
}

interface SigningConfig {
  keystore: string;
  alias: string;
  password: string;
  keyPassword?: string;
}

async function resolveSigning(
  loaded: LoadedConfig,
  tools: AndroidTools,
): Promise<SigningConfig> {
  const { config, projectDir } = loaded;
  if (config.android?.keystore) {
    const keystore = resolve(projectDir, config.android.keystore);
    const passwordEnv = config.android.storePasswordEnv ?? "MIO_KS_PASS";
    const password = process.env[passwordEnv];
    if (!password) {
      throw new Error(`Release keystore password is missing: set ${passwordEnv}`);
    }
    const keyEnv = config.android.keyPasswordEnv;
    const keyPassword = keyEnv ? process.env[keyEnv] : undefined;
    return {
      keystore,
      alias: config.android.alias ?? "release",
      password,
      keyPassword,
    };
  }

  const keystore = join(projectDir, ".mio", "debug.p12");
  const debug = await ensureDebugKeystore(tools, { path: keystore });
  return {
    keystore: debug.path,
    alias: debug.alias,
    password: debug.password,
  };
}

function versionCode(version: string): number {
  const [majorPart = "1", minorPart = "0", patchPart = "0"] = version.split(/[.+-]/);
  const major = Number.parseInt(majorPart, 10) || 1;
  const minor = Number.parseInt(minorPart, 10) || 0;
  const patch = Number.parseInt(patchPart, 10) || 0;
  const code = major * 1_000_000 + minor * 1_000 + patch;
  return Math.max(1, Math.min(2_100_000_000, code));
}
