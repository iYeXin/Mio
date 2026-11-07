// Side-effect import: installs window.Mio before app code runs. In production
// the runtime also injects this file before the app bundle; the bootstrap
// guards against double installation.
import "../bootstrap.js";
import type { BridgeState, MioBridge } from "./types.js";

export type {
  BridgeState,
  MioBridge,
  MioBootstrap,
} from "./types.js";

export interface AppFeatures {
  /** `nativeApi` is usable: supported platform and a packaged build. */
  native: boolean;
  /** `processApi` is usable (Windows only). */
  process: boolean;
  /** Window controls are available. */
  window: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  version: string;
  title: string;
  platform: string;
  apiVersion: string;
  templateVersion: string;
  /** True when the page is served by a dev server instead of the app archive. */
  dev: boolean;
  /** ISO timestamp of when the shell started. */
  startedAt: string;
  /** Milliseconds since the shell started. */
  uptimeMs: number;
  features: AppFeatures;
}

export interface PlatformInfo {
  os: string;
  osVersion: string;
  locale: string;
  processors: number;
  platform: string;
  /** ABI this shell runs as: `arm64`, `x64`, `arm`, `x86`. */
  abi: string;
}

export interface AppPaths {
  /** Root of everything the app owns. */
  data: string;
  /** The only writable sandbox; paths passed to `fs.*` are relative to it. */
  app: string;
  /** Where native libraries are extracted. */
  native: string;
  /** Directory of the installed executable. */
  install: string;
  /** System temp directory. */
  temp: string;
}

export interface AppLogResult {
  /** Path of the log file, relative to the `fs` sandbox. */
  path: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  modified: string;
}

export interface FileStat {
  type: string;
  size: number;
  modified: string;
}

export interface WindowState {
  supported: boolean;
  width?: number;
  height?: number;
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

export interface ProcessSpawnOptions {
  /**
   * Executable path. Relative paths are resolved against the install directory
   * (next to the app executable) and then the app data directory; absolute
   * paths must resolve inside one of those two roots.
   */
  path: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessInfo {
  id: string;
  pid: number;
  executable: string;
  cwd?: string;
}

export interface ProcessChunk {
  id: string;
  pid: number;
  bytes: Uint8Array;
}

export interface ProcessExitEvent {
  id: string;
  pid: number;
  code: number;
  signal: string | null;
  executable?: string;
}

export interface NativeHandle {
  handle: string;
  name: string;
  /** ABI the library was checked against, e.g. `arm64` or `x64`. */
  abi: string;
  /** Path inside the app archive, e.g. `native/arm64/demo.so`. */
  path: string;
  /** Absolute path of the extracted copy the loader opened. */
  file: string;
  /** Whether the library exports the optional `mio_start` entry point. */
  entry: boolean;
  started: boolean;
}

export interface NativeStartResult {
  handle: string;
  /** Value returned by `mio_start`; null when the entry is still running. */
  code: number | null;
  running: boolean;
}

export interface NativeStopResult {
  handle: string;
  /** True when `mio_stop` existed and returned. */
  stopped: boolean;
  /** `not started`, `no mio_stop`, or the error the export raised. */
  reason?: string;
  /** The export did not return within the shutdown budget. */
  timedOut?: boolean;
}

export interface NativeEvent {
  handle: string;
  /** Caller-chosen id passed to the sink by native code. */
  event: number;
  a: number;
  b: number;
  c: number;
}

export type NativeValue = number | string;

function toBase64(data: Uint8Array | ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function waitForBridge(timeoutMs = 10_000): Promise<MioBridge> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Mio API is only available in a browser"));
  }
  if (window.Mio) return Promise.resolve(window.Mio);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (window.Mio) {
        window.clearInterval(timer);
        resolve(window.Mio);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error("Mio bridge did not become ready"));
      }
    }, 50);
  });
}

async function injectBootstrapFromQuery(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const port = params.get("__mio_port");
  if (!port) return false;
  if (document.querySelector("script[data-mio-bootstrap]")) return true;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `http://127.0.0.1:${port}/__mio__/bootstrap.js`;
    script.async = true;
    script.dataset.mioBootstrap = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the Mio bootstrap"));
    document.head.appendChild(script);
  });
  return true;
}

export async function getMio(): Promise<MioBridge> {
  if (typeof window === "undefined") {
    throw new Error("Mio API is only available in a browser");
  }
  if (window.Mio) return window.Mio;

  // Dev mode: the shell adds __mio_port/__mio_token to the Vite URL. The
  // bootstrap file may also be bundled by the app, in which case this is a
  // no-op. Either way window.Mio is installed exactly once.
  if (!window.Mio) {
    try {
      await injectBootstrapFromQuery();
    } catch {
      // Fall through to waitForBridge for a useful timeout.
    }
  }
  return await waitForBridge();
}

async function invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const bridge = await getMio();
  return await bridge.invoke<T>(method, params);
}

async function subscribeProcessStream(
  name: "process.stdout" | "process.stderr",
  handler: (chunk: ProcessChunk) => void,
): Promise<() => void> {
  return await Mio.on(name, (data) => {
    const event = data as { id: string; pid: number; data: string };
    handler({ id: event.id, pid: event.pid, bytes: fromBase64(event.data) });
  });
}

/**
 * Native libraries with a small, fixed scalar ABI.
 *
 * A library is packed under `native/<abi>/<name>.so|dll` in the app content,
 * extracted to the app data directory on first load, and opened with `dlopen` /
 * `LoadLibrary`. Two ways to use it:
 *
 * - `call` invokes exported functions with the supported scalar signatures
 *   (`i32`, `i64`, `f64`, `str` arguments; `void`, `i32`, `i64`, `f64` returns);
 * - `start` calls the optional `mio_start(sink, config)` entry, after which the
 *   library can push scalar events to the page through the sink.
 *
 * Anything beyond scalars — buffers, structs, callbacks with pointers — is out
 * of scope by design: use files, the blob endpoint, or a sidecar process.
 */
export const nativeApi = {
  /** Loads `native/<abi>/<name>.<ext>` from the app content. */
  load: (name: string): Promise<NativeHandle> => invoke("native.load", { name }),

  /** Calls `mio_start(sink, config)`; returns its result or reports it running. */
  start: (handle: string, config?: string): Promise<NativeStartResult> =>
    invoke("native.start", { handle, config }),

  /**
   * Calls the optional `mio_stop()` export and marks the library as stopped.
   * The library stays loaded; `start` can be called again afterwards.
   */
  stop: (handle: string): Promise<NativeStopResult> => invoke("native.stop", { handle }),

  /**
   * Calls an exported function. `signature` must be one of the supported
   * shapes, e.g. `i32(i32,i32)`, `f64(str)`, `void()`.
   */
  call: (
    handle: string,
    symbol: string,
    signature: string,
    args: NativeValue[] = [],
  ): Promise<number | null> => invoke("native.call", { handle, symbol, signature, args }),

  /**
   * Pushes a scalar event into the library through its optional `mio_event`
   * export — the reverse direction of `onEvent`:
   *
   * ```c
   * void mio_event(int32_t event, int64_t a, int64_t b, double c);
   * ```
   */
  emit: (
    handle: string,
    event: number,
    a = 0,
    b = 0,
    c = 0,
  ): Promise<void> => invoke("native.emit", { handle, event, a, b, c }),

  list: (): Promise<NativeHandle[]> => invoke("native.list"),

  /** Scalar events pushed by native code through the `mio_start` sink. */
  onEvent: (handler: (event: NativeEvent) => void): Promise<() => void> =>
    Mio.on("native.event", (data) => handler(data as NativeEvent)),
};

/**
 * Sidecar processes. Windows only; every other platform rejects with
 * `UNSUPPORTED`.
 *
 * Mio does not provide native plugins. This namespace only starts a process and
 * moves its stdio; the wire protocol between the app and the sidecar is the
 * app's own business. Named `processApi` rather than `process` so importing it
 * never shadows the global `process`.
 */
export const processApi = {
  spawn: (options: ProcessSpawnOptions): Promise<ProcessInfo> =>
    invoke("process.spawn", { ...options }),

  /** Sends bytes to the child's stdin. Strings are encoded as UTF-8. */
  write: (id: string, data: Uint8Array | ArrayBuffer | string): Promise<void> =>
    invoke("process.write", { id, data: toBase64(data) }),

  closeStdin: (id: string): Promise<void> => invoke("process.closeStdin", { id }),

  /** SIGTERM, escalating to SIGKILL after five seconds. */
  kill: (
    id: string,
    signal: "term" | "kill" = "term",
  ): Promise<{ id: string; pid: number; killed: boolean }> =>
    invoke("process.kill", { id, signal }),

  list: (): Promise<ProcessInfo[]> => invoke("process.list"),

  /** stdout chunks; concatenate `bytes` — chunk boundaries are arbitrary. */
  onStdout: (handler: (chunk: ProcessChunk) => void): Promise<() => void> =>
    subscribeProcessStream("process.stdout", handler),

  onStderr: (handler: (chunk: ProcessChunk) => void): Promise<() => void> =>
    subscribeProcessStream("process.stderr", handler),

  onExit: (handler: (event: ProcessExitEvent) => void): Promise<() => void> =>
    Mio.on("process.exit", (data) => handler(data as ProcessExitEvent)),
};

export const Mio = {
  get ready() {
    return getMio().then((bridge) => bridge.ready);
  },
  /** `connecting` | `open` | `closed`; changes arrive as `bridge.state`. */
  async connectionState(): Promise<BridgeState> {
    return (await getMio()).state;
  },
  async invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return await invoke<T>(method, params);
  },
  async on(name: string, handler: (data: unknown) => void): Promise<() => void> {
    return (await getMio()).on(name, handler);
  },
  async off(name: string, handler: (data: unknown) => void): Promise<void> {
    (await getMio()).off(name, handler);
  },
  async once(name: string, handler: (data: unknown) => void): Promise<() => void> {
    return (await getMio()).once(name, handler);
  },
  process: processApi,
  native: nativeApi,
};

export const app = {
  info: (): Promise<AppInfo> => invoke("app.info"),
  /** Absolute directories the app owns; `app` is the writable sandbox. */
  paths: (): Promise<AppPaths> => invoke("app.paths"),
  /**
   * Appends a timestamped `level message` line to `logs/mio.log` (rotated at
   * ~1 MB). Android has no console, so the file is the useful sink.
   */
  log: (level: "debug" | "info" | "warn" | "error", message: string): Promise<AppLogResult> =>
    invoke("app.log", { level, message }),
  quit: (): Promise<void> => invoke("app.quit"),
};

export const platform = {
  info: (): Promise<PlatformInfo> => invoke("platform.info"),
};

export const fs = {
  readText: (path: string): Promise<string> => invoke("fs.readText", { path }),
  writeText: (path: string, text: string): Promise<void> =>
    invoke("fs.writeText", { path, text }),
  appendText: (path: string, text: string): Promise<void> =>
    invoke("fs.appendText", { path, text }),
  // Binary reads and writes go through the HTTP blob endpoint: they stream and
  // avoid the base64 round trip that the JSON methods need.
  readBytes: async (path: string): Promise<Uint8Array> =>
    (await getMio()).readBlob(path),
  writeBytes: async (path: string, data: Uint8Array | ArrayBuffer): Promise<void> =>
    await (await getMio()).writeBlob(path, data),
  list: (path = "."): Promise<FileEntry[]> => invoke("fs.list", { path }),
  stat: (path: string): Promise<FileStat | null> => invoke("fs.stat", { path }),
  mkdir: (path: string): Promise<void> => invoke("fs.mkdir", { path }),
  remove: (path: string, recursive = false): Promise<boolean> =>
    invoke("fs.remove", { path, recursive }),
  rename: (from: string, to: string): Promise<void> => invoke("fs.rename", { from, to }),
  exists: (path: string): Promise<boolean> => invoke("fs.exists", { path }),
  /** URL usable with fetch() for streaming reads (Range supported). */
  blobUrl: async (path: string): Promise<string> => (await getMio()).blobUrl(path),
};

export const dialog = {
  openFile: (extensions?: string[]): Promise<string | null> =>
    invoke("dialog.openFile", { extensions }),
  openDirectory: (): Promise<string | null> => invoke("dialog.openDirectory"),
  saveFile: (suggestedName?: string): Promise<string | null> =>
    invoke("dialog.saveFile", { suggestedName }),

};

export const clipboard = {
  readText: (): Promise<string | null> => invoke("clipboard.readText"),
  writeText: (text: string): Promise<void> => invoke("clipboard.writeText", { text }),
};

export const shell = {
  openExternal: (url: string): Promise<void> => invoke("shell.openExternal", { url }),
  /**
   * Opens a file from the app sandbox with the system default application.
   * Windows only: Android would need a content provider Mio does not ship.
   */
  openPath: (path: string): Promise<void> => invoke("shell.openPath", { path }),
  /** Shows a sandbox file or folder in Explorer, selected when possible. */
  reveal: (path: string): Promise<void> => invoke("shell.reveal", { path }),
};

export const windowApi = {
  state: (): Promise<WindowState> => invoke("window.state"),
  setTitle: (title: string): Promise<void> => invoke("window.setTitle", { title }),
  minimize: (): Promise<void> => invoke("window.minimize"),
  maximize: (): Promise<void> => invoke("window.maximize"),
  restore: (): Promise<void> => invoke("window.restore"),
  close: (): Promise<void> => invoke("window.close"),
  center: (): Promise<void> => invoke("window.center"),
  moveTo: (x: number, y: number): Promise<void> => invoke("window.moveTo", { x, y }),
  setSize: (width: number, height: number): Promise<void> =>
    invoke("window.setSize", { width, height }),
  setFullScreen: (fullScreen: boolean): Promise<void> =>
    invoke("window.setFullScreen", { fullScreen }),
  setAlwaysOnTop: (alwaysOnTop: boolean): Promise<void> =>
    invoke("window.setAlwaysOnTop", { alwaysOnTop }),
};

export default Mio;
