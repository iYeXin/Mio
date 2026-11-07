import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverAndroidTools, type AndroidTools } from "./discover.js";
import { MioToolError } from "./errors.js";
import {
  signApkWithApksigner,
  verifyApkWithApksigner,
  type SignApkWithApksignerOptions,
  type VerifyResult,
} from "./apksigner.js";
import { alignApk, type PageSize } from "./zipalign.js";

export interface SignApkOptions
  extends Omit<SignApkWithApksignerOptions, "input" | "output"> {
  input: string;
  output: string;
  /** Reuse an already discovered toolchain; otherwise discover it. */
  tools?: AndroidTools;
  /** 16 KiB by default (Android 15+). Use 4 for older build-tools. */
  pageSize?: PageSize;
}

export interface SignResult {
  output: string;
  tools: AndroidTools;
  verify: VerifyResult;
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
 * Align, sign, and verify an APK.
 *
 * This is the only supported high-level Android signing entry point: alignment
 * must happen before apksigner, and the result must be verified before it is
 * treated as a build artifact.
 */
export async function signApk(options: SignApkOptions): Promise<SignResult> {
  const tools = options.tools ?? (await discoverAndroidTools());
  const input = resolve(options.input);
  const output = resolve(options.output);

  if (!(await exists(input))) {
    throw new MioToolError("MISSING_FILE", `Input APK does not exist: ${input}`);
  }
  if (input === output) {
    throw new MioToolError(
      "INVALID_ARGUMENT",
      "Input and output APK must be different files.",
      { details: "Write the signed artifact to a new path so a failed build cannot destroy the input." },
    );
  }

  await mkdir(dirname(output), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "mio-sign-"));
  const aligned = join(tempDir, "aligned.apk");
  const signed = join(tempDir, "signed.apk");

  try {
    await alignApk(tools, input, aligned, {
      pageSize: options.pageSize ?? 16,
      verbose: options.verbose,
    });

    await signApkWithApksigner(tools, {
      ...options,
      input: aligned,
      output: signed,
    });

    const verify = await verifyApkWithApksigner(tools, signed, {
      minSdkVersion: options.minSdkVersion,
    });

    if (!verify.verified) {
      throw new MioToolError("APKSIGNER_VERIFY_FAILED", "Signed APK did not verify", {
        stdout: verify.raw,
        details: `exit code ${verify.exitCode}`,
      });
    }

    // Only publish the output after it has passed verification.
    await copyFile(signed, output);
    return { output, tools, verify };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyApk(
  apk: string,
  options: { tools?: AndroidTools; minSdkVersion?: number } = {},
): Promise<VerifyResult> {
  const tools = options.tools ?? (await discoverAndroidTools());
  return await verifyApkWithApksigner(tools, resolve(apk), {
    minSdkVersion: options.minSdkVersion,
  });
}
