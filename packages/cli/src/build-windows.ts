import { cp, mkdtemp, rm, stat, copyFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { injectWindowsExe } from "@iyexin/mio-android-tools";
import type { LoadedConfig } from "./config.js";
import { createAppAsar } from "./asar.js";
import { resolveWindowsTemplate } from "./templates.js";
import { ensureWebBuild, runShell } from "./web.js";
import { findFirstExe, safeName } from "./project.js";

export interface BuildWindowsOptions {
  loaded: LoadedConfig;
  skipWeb: boolean;
  /** Overrides the resolved template path (--template). */
  template?: string;
}

export interface BuildWindowsResult {
  outputDir: string;
  exe: string;
  size: number;
}

export async function buildWindows(options: BuildWindowsOptions): Promise<BuildWindowsResult> {
  const { config, projectDir } = options.loaded;
  const webDir = await ensureWebBuild(projectDir, config, options.skipWeb);
  const template = await resolveWindowsTemplate(projectDir, config, {
    explicit: options.template,
    log: (message) => console.error(message),
  });
  const templateDir = template.path;
  const outputDir = resolve(projectDir, "build", "mio", "windows", safeName(config.app.name));

  const temp = await mkdtemp(join(tmpdir(), "mio-windows-build-"));
  const asarPath = join(temp, "app.asar");
  const injectedExe = join(temp, "injected.exe");

  try {
    await createAppAsar({ webDir, output: asarPath, config });
    await rm(outputDir, { recursive: true, force: true });
    await cp(templateDir, outputDir, { recursive: true });

    const configuredExe = config.windows?.exe;
    const exe = configuredExe
      ? join(outputDir, configuredExe)
      : await findFirstExe(outputDir);
    if (!exe) throw new Error(`Windows template has no exe: ${templateDir}`);

    await injectWindowsExe({
      templateExe: exe,
      asar: asarPath,
      output: injectedExe,
      appName: config.app.name,
      version: config.app.version,
      icon: config.app.icon ? resolve(projectDir, config.app.icon) : undefined,
    });
    await copyFile(injectedExe, exe);

    const finalExe = config.windows?.exe
      ? exe
      : join(outputDir, `${safeName(config.app.name)}.exe`);
    if (finalExe !== exe) {
      await rm(finalExe, { force: true });
      await rename(exe, finalExe);
    }

    if (config.windows?.signCommand) {
      const command = config.windows.signCommand.replaceAll("{exe}", `"${finalExe}"`);
      await runShell(command, projectDir);
    }

    return {
      outputDir,
      exe: finalExe,
      size: await directorySize(outputDir),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else total += (await stat(path)).size;
  }
  return total;
}
