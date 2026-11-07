import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { LoadedConfig } from "./config.js";
import { findFirstExe } from "./project.js";
import { resolveDevAndroidTemplate, resolveWindowsTemplate } from "./templates.js";

export interface DevOptions {
  loaded: LoadedConfig;
  platform: "android" | "windows";
  install: boolean;
  /** Overrides the resolved template path (--template). */
  template?: string;
}

export async function dev(options: DevOptions): Promise<void> {
  const { config, projectDir } = options.loaded;
  const port = await freePort(config.web?.devUrl);
  const devUrl = `http://127.0.0.1:${port}`;
  const baseCommand = config.web?.devCommand ?? "npm run dev";
  const devCommand = baseCommand.includes("--port")
    ? baseCommand
    : `${baseCommand} -- --host 127.0.0.1 --port ${port}`;

  console.log(`Starting web dev server: ${devCommand}`);
  const vite = spawn(devCommand, {
    cwd: projectDir,
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
  const children: ChildProcess[] = [vite];

  try {
    await waitForHttp(devUrl, 60_000);
    console.log(`Web dev server is ready at ${devUrl}`);

    if (options.platform === "windows") {
      await startWindows(options, devUrl, children);
    } else {
      await startAndroid(options, devUrl);
    }
    console.log("Mio dev is running. Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        for (const child of children) child.kill();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    for (const child of children) {
      if (!child.killed) child.kill();
    }
  }
}

async function startWindows(
  options: DevOptions,
  devUrl: string,
  children: ChildProcess[],
): Promise<void> {
  const { config, projectDir } = options.loaded;
  const templateDir = (await resolveWindowsTemplate(projectDir, config, {
    explicit: options.template,
  })).path;
  const exe = config.windows?.exe
    ? join(templateDir, config.windows.exe)
    : await findFirstExe(templateDir);
  if (!exe) throw new Error(`No Windows executable in ${templateDir}`);

  console.log(`Launching Windows shell: ${exe}`);
  const child = spawn(exe, [], {
    cwd: templateDir,
    stdio: "inherit",
    env: {
      ...process.env,
      MIO_DEV_URL: devUrl,
      MIO_DEV_APP_ID: config.app.id,
      MIO_DEV_APP_NAME: config.app.name,
      MIO_DEV_APP_VERSION: config.app.version,
      MIO_DEV_WINDOW_WIDTH: String(config.window?.width ?? 1024),
      MIO_DEV_WINDOW_HEIGHT: String(config.window?.height ?? 720),
    },
  });
  children.push(child);
}

async function startAndroid(options: DevOptions, devUrl: string): Promise<void> {
  const adb = findAdb();
  const template = (await resolveDevAndroidTemplate(options.loaded.projectDir, options.loaded.config, {
    explicit: options.template,
  })).path;
  const port = new URL(devUrl).port || "5173";

  await run(adb, ["reverse", `tcp:${port}`, `tcp:${port}`]);
  if (options.install) {
    console.log(`Installing Android template: ${template}`);
    await run(adb, ["install", "-r", template]);
  }
  const appConfig = Buffer.from(
    JSON.stringify({
      id: options.loaded.config.app.id,
      name: options.loaded.config.app.name,
      version: options.loaded.config.app.version,
      width: options.loaded.config.window?.width ?? 1024,
      height: options.loaded.config.window?.height ?? 720,
    }),
  ).toString("base64");

  await run(adb, [
    "shell",
    "am",
    "start",
    "-n",
    "dev.mio.mio_shell/dev.mio.mio_shell.MainActivity",
    "--es",
    "mio.devUrl",
    devUrl,
    "--es",
    "mio.appConfig",
    appConfig,
  ]);
}

function findAdb(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const candidate = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}`));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function freePort(preferred: string | undefined): Promise<number> {
  const desired = preferred ? Number(new URL(preferred).port) : 0;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => {
      // Preferred port unavailable; let the OS choose one.
      const fallback = createServer();
      fallback.once("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        const port = typeof address === "object" && address ? address.port : 0;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(desired, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
