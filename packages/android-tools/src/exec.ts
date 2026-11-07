import { spawn } from "node:child_process";
import { MioToolError } from "./errors.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run a child process and capture stdout/stderr.
 *
 * The caller is responsible for interpreting a non-zero exit code. Spawn
 * failures and timeouts are surfaced as MioToolError.
 */
export async function run(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;

  return await new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      fail(
        new MioToolError("SPAWN_FAILED", `Failed to start ${file}: ${error.message}`, {
          cause: error,
          stdout,
          stderr,
        }),
      );
    });

    child.on("close", (code) => {
      if (timedOut) {
        fail(
          new MioToolError("TIMEOUT", `${file} timed out after ${timeoutMs}ms`, {
            stdout,
            stderr,
          }),
        );
        return;
      }
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}
