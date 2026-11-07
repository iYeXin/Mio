import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { MioConfig } from "./config.js";

export async function ensureWebBuild(
  projectDir: string,
  config: MioConfig,
  skipWeb: boolean,
): Promise<string> {
  const outDir = resolve(projectDir, config.web?.outDir ?? "dist");
  if (!skipWeb) {
    const command = config.web?.buildCommand ?? "npm run build";
    await runShell(command, projectDir);
  }
  await access(join(outDir, "index.html"), constants.F_OK).catch(() => {
    throw new Error(`Web build output is missing index.html: ${outDir}`);
  });
  return outDir;
}

export function runShell(command: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Command failed (${code}): ${command}`));
    });
  });
}
