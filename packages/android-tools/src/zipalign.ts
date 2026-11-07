import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
import { dirname, join } from "node:path";
import type { AndroidTools } from "./discover.js";

export type PageSize = 4 | 16;

export interface AlignOptions {
  pageSize?: PageSize;
  verbose?: boolean;
}

export interface AlignmentCheck {
  ok: boolean;
  raw: string;
  exitCode: number;
}

/**
 * Environment for zipalign.
 *
 * The Linux/macOS binaries in Android build-tools link against shared libraries
 * that live next to them (`lib64/`), so a copied binary alone fails with
 * "libziparchive.so.0: cannot open shared object file".
 */
function zipalignEnv(tools: AndroidTools): NodeJS.ProcessEnv | undefined {
  if (process.platform === "win32") return undefined;
  const dir = dirname(tools.zipalign);
  const paths = [join(dir, "lib64"), join(dir, "lib")];
  const key = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const existing = process.env[key];
  return {
    ...process.env,
    [key]: existing ? `${paths.join(":")}:${existing}` : paths.join(":"),
  };
}

function failureMessage(result: { stderr: string; stdout: string }): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const line = text.split(/\r?\n/).find((value) => value.trim().length > 0);
  return line ? `zipalign failed: ${line}` : "zipalign failed";
}

function pageArgs(pageSize: PageSize | undefined): string[] {
  if (pageSize === 16) return ["-P", "16"];
  // Default zipalign page alignment (4 KiB).
  return ["-p"];
}

/**
 * Run zipalign before signing. apksigner does not align; Android 15+ needs
 * 16 KiB-aligned native libraries, hence the explicit page size.
 */
export async function alignApk(
  tools: AndroidTools,
  input: string,
  output: string,
  options: AlignOptions = {},
): Promise<void> {
  const args = ["-f", ...pageArgs(options.pageSize)];
  if (options.verbose) args.push("-v");
  args.push("4", input, output);

  const env = zipalignEnv(tools);
  let result = await run(tools.zipalign, args, { timeoutMs: 120_000, env });
  if (result.code !== 0 && options.pageSize === 16) {
    // Older zipalign builds (e.g. the distro package on linux-arm64) predate
    // `-P`; fall back to 4 KiB page alignment rather than failing the build.
    result = await run(tools.zipalign, ["-f", "-p", "4", input, output], {
      timeoutMs: 120_000,
      env,
    });
  }
  if (result.code !== 0) {
    throw new MioToolError("ZIPALIGN_FAILED", failureMessage(result), {
      stdout: result.stdout,
      stderr: result.stderr,
      details: `exit code ${result.code}`,
    });
  }
}

export async function checkAlignment(
  tools: AndroidTools,
  apk: string,
  options: AlignOptions = {},
): Promise<AlignmentCheck> {
  const args = ["-c", "-v", ...pageArgs(options.pageSize), "4", apk];
  const env = zipalignEnv(tools);
  let result = await run(tools.zipalign, args, { timeoutMs: 120_000, env });
  if (result.code !== 0 && options.pageSize === 16) {
    result = await run(tools.zipalign, ["-c", "-v", "-p", "4", apk], {
      timeoutMs: 120_000,
      env,
    });
  }
  return {
    ok: result.code === 0,
    raw: `${result.stdout}${result.stderr}`,
    exitCode: result.code,
  };
}
