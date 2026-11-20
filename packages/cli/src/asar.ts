import { copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createPackage } from "@electron/asar";
import { themedEntries, type MioConfig, type Themed } from "./config.js";
import { MIO_API_VERSION, MIO_CLI_VERSION } from "./constants.js";

export interface CreateAsarOptions {
  webDir: string;
  output: string;
  config: MioConfig;
  /** Project root, used to resolve `window.splash`; required when it is set. */
  projectDir?: string;
}

export interface CreateAsarResult {
  output: string;
  size: number;
}

/** Archive path per brightness; a missing variant falls back in the shell. */
interface ThemedStrings {
  light?: string;
  dark?: string;
}

/** `Themed<T>` as explicit `{ light, dark }`; a shared value fills both. */
function themedValues<T>(value: Themed<T> | undefined): { light?: T; dark?: T } {
  const out: { light?: T; dark?: T } = {};
  for (const entry of themedEntries(value)) {
    if (entry.variant === "") {
      out.light = entry.value;
      out.dark = entry.value;
    } else {
      out[entry.variant] = entry.value;
    }
  }
  return out;
}

function themedColors(value: Themed<string> | undefined, fallback: string): ThemedStrings {
  const values = themedValues(value);
  const light = values.light ?? fallback;
  return { light, dark: values.dark ?? light };
}

/**
 * Copies every splash variant into the archive under `__mio__/`.
 *
 * Both variants live in the same archive: the shell picks one at startup from
 * `window.theme` (or the system brightness), which the page cannot do because
 * it has not run yet.
 */
async function stageSplash(
  options: CreateAsarOptions,
  stage: string,
): Promise<ThemedStrings | undefined> {
  const values = themedValues(options.config.window?.splash);
  if (values.light === undefined && values.dark === undefined) return undefined;
  if (!options.projectDir) {
    throw new Error("projectDir is required when window.splash is set");
  }
  await mkdir(join(stage, "__mio__"), { recursive: true });
  const staged: ThemedStrings = {};
  for (const variant of ["light", "dark"] as const) {
    const source = values[variant];
    if (source === undefined) continue;
    const entry = `__mio__/splash-${variant}${extname(source).toLowerCase()}`;
    await copyFile(resolve(options.projectDir, source), join(stage, entry));
    staged[variant] = entry;
  }
  return staged;
}

export async function createAppAsar(options: CreateAsarOptions): Promise<CreateAsarResult> {
  const stage = await mkdtemp(join(tmpdir(), "mio-asar-"));
  try {
    await cp(options.webDir, stage, { recursive: true });

    const backgroundColor = options.config.window?.backgroundColor ?? "#0f1115";
    const backgrounds = themedColors(options.config.window?.splashBackground, backgroundColor);
    const splash = await stageSplash(options, stage);
    const android = {
      ...(options.config.android?.foregroundService ? { foregroundService: true } : {}),
      ...(options.config.android?.statusBar ? { statusBar: options.config.android.statusBar } : {}),
      ...(options.config.android?.orientation ? { orientation: options.config.android.orientation } : {}),
    };

    const manifest = {
      id: options.config.app.id,
      name: options.config.app.name,
      version: options.config.app.version,
      entry: "index.html",
      window: {
        width: options.config.window?.width ?? 1024,
        height: options.config.window?.height ?? 720,
        title: options.config.window?.title ?? options.config.app.name,
        backgroundColor,
        theme: options.config.window?.theme ?? "system",
        ...(splash
          ? {
              splash,
              splashBackground: backgrounds,
              splashFit: options.config.window?.splashFit ?? "contain",
            }
          : {}),
        ...(options.config.window?.x !== undefined ? { x: options.config.window.x } : {}),
        ...(options.config.window?.y !== undefined ? { y: options.config.window.y } : {}),
        ...(options.config.window?.center === false ? { center: false } : {}),
        ...(options.config.window?.resizable === false ? { resizable: false } : {}),
        ...(options.config.window?.decorations === false ? { decorations: false } : {}),
        ...(options.config.window?.alwaysOnTop ? { alwaysOnTop: true } : {}),
        ...(options.config.window?.minWidth !== undefined
          ? { minWidth: options.config.window.minWidth }
          : {}),
        ...(options.config.window?.minHeight !== undefined
          ? { minHeight: options.config.window.minHeight }
          : {}),
      },
      ...(options.config.devtools !== undefined ? { devtools: options.config.devtools } : {}),
      requires: {
        apiVersion: MIO_API_VERSION,
      },
      ...(Object.keys(android).length > 0 ? { android } : {}),
      build: {
        cli: MIO_CLI_VERSION,
        api: MIO_API_VERSION,
      },
    };
    await writeFile(
      join(stage, "mio-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const require = createRequire(import.meta.url);
    const bootstrap = require.resolve("@iyexin/mio-api/bootstrap.js");
    await mkdir(join(stage, "__mio__"), { recursive: true });
    await copyFile(bootstrap, join(stage, "__mio__", "bootstrap.js"));

    await createPackage(stage, options.output);
    const info = await stat(options.output);
    return { output: options.output, size: info.size };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
