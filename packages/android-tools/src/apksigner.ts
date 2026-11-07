import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
import type { AndroidTools } from "./discover.js";

export interface SignApkWithApksignerOptions {
  input: string;
  output: string;
  keystore: string;
  keystorePassword: string;
  keyAlias: string;
  keyPassword?: string;
  minSdkVersion?: number;
  v1?: boolean;
  v2?: boolean;
  v3?: boolean;
  verbose?: boolean;
}

export interface SignerCertificate {
  signer: number;
  dn?: string;
  sha256?: string;
  sha1?: string;
  md5?: string;
  keyAlgorithm?: string;
  keySizeBits?: number;
}

export interface VerifyResult {
  verified: boolean;
  v1: boolean;
  v2: boolean;
  v3: boolean;
  v4: boolean;
  signers: SignerCertificate[];
  exitCode: number;
  raw: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseBool(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

/**
 * Parse `apksigner verify --verbose --print-certs` output.
 * Exported so the parser can be unit tested without a JVM.
 */
export function parseVerifyOutput(output: string, exitCode = 0): VerifyResult {
  const normalized = output.replace(/\r\n/g, "\n");
  const scheme = (label: string): boolean => {
    const expression = new RegExp(`Verified using ${label}[^:]*:\\s*(true|false)`, "i");
    return parseBool(expression.exec(normalized)?.[1]);
  };

  const signers: SignerCertificate[] = [];
  let current: SignerCertificate | undefined;
  for (const line of normalized.split("\n")) {
    const signerMatch = /^Signer #(\d+) certificate DN:\s*(.*)$/.exec(line);
    if (signerMatch) {
      current = { signer: Number(signerMatch[1]), dn: signerMatch[2] };
      signers.push(current);
      continue;
    }
    if (!current) continue;

    const sha256 = /^Signer #\d+ certificate SHA-256 digest:\s*(\S+)/.exec(line);
    if (sha256) {
      current.sha256 = sha256[1];
      continue;
    }
    const sha1 = /^Signer #\d+ certificate SHA-1 digest:\s*(\S+)/.exec(line);
    if (sha1) {
      current.sha1 = sha1[1];
      continue;
    }
    const md5 = /^Signer #\d+ certificate MD5 digest:\s*(\S+)/.exec(line);
    if (md5) {
      current.md5 = md5[1];
      continue;
    }
    const key = /^Signer #\d+ key algorithm:\s*(.+)$/.exec(line);
    if (key) {
      current.keyAlgorithm = key[1]?.trim();
      continue;
    }
    const bits = /^Signer #\d+ key size \(bits\):\s*(\d+)/.exec(line);
    if (bits) {
      current.keySizeBits = Number(bits[1]);
    }
  }

  const verified =
    exitCode === 0 &&
    /^Verifies$/m.test(normalized) &&
    !/DOES NOT VERIFY/i.test(normalized);

  return {
    verified,
    v1: scheme("v1 scheme"),
    v2: scheme("v2 scheme"),
    v3: scheme("v3 scheme"),
    v4: scheme("v4 scheme"),
    signers,
    exitCode,
    raw: normalized,
  };
}

function resolveV1(options: SignApkWithApksignerOptions): boolean {
  if (options.v1 !== undefined) return options.v1;
  if (options.minSdkVersion !== undefined) return options.minSdkVersion < 24;
  return true;
}

export function buildSignArgs(options: SignApkWithApksignerOptions): string[] {
  const v1 = resolveV1(options);
  const v2 = options.v2 ?? true;
  const v3 = options.v3 ?? true;

  const args = [
    "sign",
    "--ks",
    options.keystore,
    "--ks-key-alias",
    options.keyAlias,
    "--ks-pass",
    "env:MIO_KS_PASS",
    "--key-pass",
    "env:MIO_KEY_PASS",
    "--out",
    options.output,
    "--v1-signing-enabled",
    String(v1),
    "--v2-signing-enabled",
    String(v2),
    "--v3-signing-enabled",
    String(v3),
  ];

  if (options.minSdkVersion !== undefined) {
    args.push("--min-sdk-version", String(options.minSdkVersion));
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  args.push(options.input);
  return args;
}

export async function signApkWithApksigner(
  tools: AndroidTools,
  options: SignApkWithApksignerOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (!(await exists(options.input))) {
    throw new MioToolError("MISSING_FILE", `Input APK does not exist: ${options.input}`);
  }
  if (!(await exists(options.keystore))) {
    throw new MioToolError(
      "KEYSTORE_NOT_FOUND",
      `Keystore does not exist: ${options.keystore}`,
    );
  }

  const keyPassword = options.keyPassword ?? options.keystorePassword;
  const result = await run(tools.java, ["-jar", tools.apksignerJar, ...buildSignArgs(options)], {
    env: {
      MIO_KS_PASS: options.keystorePassword,
      MIO_KEY_PASS: keyPassword,
    },
    timeoutMs: 300_000,
  });

  if (result.code !== 0) {
    throw new MioToolError("APKSIGNER_SIGN_FAILED", "apksigner sign failed", {
      stdout: result.stdout,
      stderr: result.stderr,
      details: `exit code ${result.code}`,
    });
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

export interface VerifyApkOptions {
  minSdkVersion?: number;
  printCerts?: boolean;
}

export async function verifyApkWithApksigner(
  tools: AndroidTools,
  apk: string,
  options: VerifyApkOptions = {},
): Promise<VerifyResult> {
  if (!(await exists(apk))) {
    throw new MioToolError("MISSING_FILE", `APK does not exist: ${apk}`);
  }

  const args = ["verify", "--verbose"];
  if (options.printCerts ?? true) {
    args.push("--print-certs");
  }
  if (options.minSdkVersion !== undefined) {
    args.push("--min-sdk-version", String(options.minSdkVersion));
  }
  args.push(apk);

  const result = await run(tools.java, ["-jar", tools.apksignerJar, ...args], {
    timeoutMs: 120_000,
  });
  const raw = `${result.stdout}${result.stderr}`;
  return parseVerifyOutput(raw, result.code);
}
