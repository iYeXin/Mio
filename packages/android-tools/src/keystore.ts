import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
import type { AndroidTools } from "./discover.js";

export interface KeystoreOptions {
  /** Where to write the keystore. */
  path: string;
  /** Keystore alias. Defaults to "release". */
  alias?: string;
  /** Keystore password. */
  password?: string;
  /**
   * Read the password from this environment variable instead of passing it on
   * the keytool command line.
   */
  passwordEnv?: string;
  /** Key password when it differs from the store password (PKCS12 ignores it). */
  keyPassword?: string;
  /** Defaults to "CN=Mio, O=Mio, C=CN". */
  distinguishedName?: string;
  /** Valid days. Defaults to 10000 (~27 years). */
  validityDays?: number;
  /** RSA key size. Defaults to 2048. */
  keySize?: number;
  /** Overwrite an existing file. */
  force?: boolean;
}

export interface KeytoolArgs {
  alias: string;
  password: string;
  /** When set, the password is read from this environment variable instead of argv. */
  passwordEnv?: string;
  keyPassword?: string;
  distinguishedName?: string;
  validityDays?: number;
  keySize?: number;
}

function keytoolArgs(options: KeytoolArgs, path: string, storetype: string): string[] {
  const credentials = options.passwordEnv
    ? ["-storepass:env", options.passwordEnv, "-keypass:env", options.passwordEnv]
    : ["-storepass", options.password, "-keypass", options.keyPassword ?? options.password];
  return [
    "-genkeypair",
    "-keystore",
    path,
    "-storetype",
    storetype,
    "-alias",
    options.alias,
    "-keyalg",
    "RSA",
    "-keysize",
    String(options.keySize ?? 2048),
    "-validity",
    String(options.validityDays ?? 10000),
    ...credentials,
    "-dname",
    options.distinguishedName ?? "CN=Mio, O=Mio, C=CN",
    "-noprompt",
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runKeytool(tools: AndroidTools, args: string[]): Promise<void> {
  if (!tools.keytool) {
    throw new MioToolError(
      "KEYTOOL_NOT_FOUND",
      "keytool is required to generate a keystore but was not found.",
      {
        details:
          "Mio's tool bundle includes keytool; run an Android build once to download it, or use a JDK that ships keytool.",
      },
    );
  }
  const result = await run(tools.keytool, args, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new MioToolError("KEYTOOL_FAILED", "keytool failed to create the keystore", {
      stdout: result.stdout,
      stderr: result.stderr,
      details: `exit code ${result.code}`,
    });
  }
}

/**
 * Generate a fresh signing keystore with keytool.
 *
 * This is the same keytool that ships inside the Mio tool bundle, so a machine
 * with no JDK can still create its own release key.
 */
export async function generateKeystore(
  tools: AndroidTools,
  options: KeystoreOptions,
): Promise<{ path: string; alias: string; storetype: "PKCS12"; created: boolean }> {
  const alias = options.alias ?? "release";
  if (await exists(options.path)) {
    if (!options.force) {
      throw new MioToolError("KEYSTORE_EXISTS", `Keystore already exists: ${options.path}`, {
        details: "Pass --force to overwrite it.",
      });
    }
    await rm(options.path, { force: true });
  }
  await mkdir(dirname(options.path), { recursive: true });
  const password = options.password ?? "changeit";
  await runKeytool(
    tools,
    keytoolArgs(
      {
        alias,
        password,
        passwordEnv: options.passwordEnv,
        keyPassword: options.keyPassword,
        distinguishedName: options.distinguishedName,
        validityDays: options.validityDays,
        keySize: options.keySize,
      },
      options.path,
      "PKCS12",
    ),
  );
  return { path: options.path, alias, storetype: "PKCS12", created: true };
}

export interface DebugKeystoreOptions {
  /** Where to create the keystore. */
  path: string;
  /** Defaults to "android"; only for debug builds. */
  password?: string;
  /** Defaults to "mio-debug". */
  alias?: string;
  /** Defaults to "CN=Mio Debug, O=Mio, C=CN". */
  distinguishedName?: string;
}

/**
 * Create a debug keystore if it does not exist yet.
 *
 * Debug keys are fine for local installs; releases should use a key the
 * developer owns (see `generateKeystore`).
 */
export async function ensureDebugKeystore(
  tools: AndroidTools,
  options: DebugKeystoreOptions,
): Promise<{ path: string; alias: string; password: string }> {
  const password = options.password ?? "android";
  const alias = options.alias ?? "mio-debug";

  if (await exists(options.path)) {
    return { path: options.path, alias, password };
  }

  await mkdir(dirname(options.path), { recursive: true });
  await runKeytool(
    tools,
    keytoolArgs(
      {
        alias,
        password,
        distinguishedName: options.distinguishedName ?? "CN=Mio Debug, O=Mio, C=CN",
        validityDays: 10000,
      },
      options.path,
      "PKCS12",
    ),
  );

  return { path: options.path, alias, password };
}
