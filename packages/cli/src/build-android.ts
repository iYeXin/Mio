import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverAndroidTools,
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

export interface BuildAndroidOptions {
  loaded: LoadedConfig;
  skipWeb: boolean;
  /** Overrides the resolved template path (--template). */
  template?: string;
}

export interface BuildAndroidResult {
  output: string;
  size: number;
  verified: boolean;
}

export async function buildAndroid(options: BuildAndroidOptions): Promise<BuildAndroidResult> {
  const { config, projectDir } = options.loaded;
  const webDir = await ensureWebBuild(projectDir, config, options.skipWeb);
  const template = await resolveAndroidTemplate(projectDir, config, {
    explicit: options.template,
    log: (message) => console.error(message),
  });
  const tools = await discoverAndroidTools();

  const temp = await mkdtemp(join(tmpdir(), "mio-android-build-"));
  const asarPath = join(temp, "app.asar");
  const unsigned = join(temp, "app-unsigned.apk");
  const outputDir = resolve(projectDir, "build", "mio", "android");
  const output = join(outputDir, `${safeName(config.app.name)}-${config.app.version}.apk`);

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
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
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
