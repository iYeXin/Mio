import { resolve } from "node:path";
import { ensureAndroidTools, generateKeystore } from "@iyexin/mio-android-tools";
import { MIO_CLI_VERSION, MIO_RELEASE_BASE } from "./constants.js";
import type { LoadedConfig } from "./config.js";
import { resolveProxy } from "./download.js";

export interface KeystoreCommandOptions {
  loaded: LoadedConfig;
  /** Output path, relative to the project. Defaults to .mio/release.p12 */
  out?: string;
  alias?: string;
  distinguishedName?: string;
  validityDays?: number;
  force?: boolean;
  /** Environment variable holding the password. Defaults to MIO_KS_PASS. */
  passwordEnv?: string;
}

/**
 * Creates a release keystore with the keytool that ships in Mio's tool bundle,
 * so a machine without a JDK can still sign its own builds.
 */
export async function keystoreCommand(options: KeystoreCommandOptions): Promise<void> {
  const passwordEnv = options.passwordEnv ?? "MIO_KS_PASS";
  if (!process.env[passwordEnv]) {
    throw new Error(
      `Set ${passwordEnv} before generating a keystore, e.g.\n` +
        `  $env:${passwordEnv} = "<password>"   (PowerShell)\n` +
        `  export ${passwordEnv}=<password>     (bash)`,
    );
  }

  const resolved = await ensureAndroidTools({
    manifest:
      process.env.MIO_TOOLS_MANIFEST_URL ??
      `${MIO_RELEASE_BASE}/v${MIO_CLI_VERSION}/mio-tools.json`,
    allowDownload: process.env.MIO_NO_TOOL_DOWNLOAD !== "1",
    cacheDir: process.env.MIO_TOOLS_CACHE_DIR,
    proxy: resolveProxy(),
    force: process.env.MIO_TOOLS_FORCE_DOWNLOAD === "1",
    log: (message) => console.error(`[tools] ${message}`),
  });

  if (!resolved.tools.keytool) {
    throw new Error("keytool is not available in the resolved toolchain");
  }

  const out = resolve(options.loaded.projectDir, options.out ?? ".mio/release.p12");
  const alias = options.alias ?? "release";
  const result = await generateKeystore(resolved.tools, {
    path: out,
    alias,
    passwordEnv,
    distinguishedName: options.distinguishedName,
    validityDays: options.validityDays,
    force: options.force,
  });

  console.log(`Keystore: ${result.path}`);
  console.log(`Alias:    ${alias}`);
  console.log("");
  console.log("Add this to mio.config.json (the password stays in the environment):");
  console.log(
    JSON.stringify(
      {
        android: {
          keystore: result.path.replace(options.loaded.projectDir, "").replace(/^[\\/]/, "").replaceAll("\\", "/"),
          alias,
          storePasswordEnv: passwordEnv,
        },
      },
      null,
      2,
    ),
  );
}
