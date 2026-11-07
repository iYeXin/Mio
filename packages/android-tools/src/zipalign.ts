import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
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

  const result = await run(tools.zipalign, args, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new MioToolError("ZIPALIGN_FAILED", "zipalign failed", {
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
  const result = await run(tools.zipalign, args, { timeoutMs: 120_000 });
  return {
    ok: result.code === 0,
    raw: `${result.stdout}${result.stderr}`,
    exitCode: result.code,
  };
}
