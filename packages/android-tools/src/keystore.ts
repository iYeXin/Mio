import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
import type { AndroidTools } from "./discover.js";

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a debug keystore if it does not exist yet.
 *
 * Never use this key for release artifacts. Release keys are supplied by the
 * developer and must not be generated or stored by Mio.
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

  if (!tools.keytool) {
    throw new MioToolError(
      "KEYTOOL_NOT_FOUND",
      "keytool is required to generate a debug keystore but was not found.",
      {
        details: "Use a JDK/JRE that includes keytool, or provide an existing debug keystore.",
      },
    );
  }

  await mkdir(dirname(options.path), { recursive: true });

  const args = [
    "-genkeypair",
    "-keystore",
    options.path,
    "-storetype",
    "PKCS12",
    "-alias",
    alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-storepass",
    password,
    "-keypass",
    password,
    "-dname",
    options.distinguishedName ?? "CN=Mio Debug, O=Mio, C=CN",
    "-noprompt",
  ];

  const result = await run(tools.keytool, args, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new MioToolError("KEYTOOL_FAILED", "keytool failed to create the debug keystore", {
      stdout: result.stdout,
      stderr: result.stderr,
      details: `exit code ${result.code}`,
    });
  }

  return { path: options.path, alias, password };
}
