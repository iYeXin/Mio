import { Mio, app, clipboard, fs } from "@iyexin/mio-api";

const el = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
};

const output = el<HTMLPreElement>("#output");
const logId = el<HTMLSpanElement>("#log-id");
const bridgeStatus = el<HTMLSpanElement>("#bridge-status");
const bridgeText = el<HTMLSpanElement>("#bridge-text");

let callCounter = 0;

function print(value: unknown, tone: "normal" | "error" = "normal", label?: string): void {
  output.dataset.tone = tone;
  output.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  callCounter += 1;
  logId.textContent = label ? `${label} · #${callCounter}` : `#${callCounter}`;
}

function setBridge(state: "pending" | "ready" | "error", label: string): void {
  bridgeStatus.dataset.state = state;
  bridgeText.textContent = label;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

async function boot(): Promise<void> {
  try {
    await Mio.ready;
    setBridge("ready", "connected");

    const info = await app.info();
    el("#app-name").textContent = info.name;
    el("#spec-id").textContent = info.id;
    el("#spec-version").textContent = info.version;
    el("#spec-platform").textContent = info.platform;
    el("#spec-api").textContent = `api ${info.apiVersion}`;
    el("#spec-template").textContent = `template ${info.templateVersion}`;
    el("#masthead-meta").textContent = `shell ${info.templateVersion}`;
    document.title = info.name;

    print(
      {
        bridge: "connected",
        app: info.id,
        platform: info.platform,
        api: info.apiVersion,
      },
      "normal",
      "ready",
    );

    await Mio.on("app.lifecycle", (event) => {
      print({ event: "app.lifecycle", data: event }, "normal", "lifecycle");
    });
  } catch (error) {
    setBridge("error", "unavailable");
    print(describe(error), "error", "error");
  }
}

const actions: Record<string, () => Promise<{ result: unknown; label: string }>> = {
  async ping() {
    return { label: "ping", result: await Mio.invoke("ping") };
  },

  async clipboard() {
    const text = `Mio clipboard ${Date.now()}`;
    await clipboard.writeText(text);
    const readBack = await clipboard.readText();
    return { label: "clipboard", result: { wrote: text.length, match: readBack === text } };
  },

  async write() {
    const path = "notes/hello.txt";
    const text = `Written at ${new Date().toISOString()}`;
    await fs.writeText(path, text);
    return {
      label: "file",
      result: {
        path,
        bytes: text.length,
        exists: await fs.exists(path),
        content: await fs.readText(path),
      },
    };
  },

  async binary() {
    const size = 64 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes.subarray(0, 65536));
    for (let index = 65536; index < size; index += 1) {
      bytes[index] = bytes[index % 65536]!;
    }

    const path = "blobs/round-trip.bin";
    const started = performance.now();
    await fs.writeBytes(path, bytes);
    const readBack = await fs.readBytes(path);
    const elapsedMs = Math.round(performance.now() - started);

    let firstDifference = -1;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== readBack[index]) {
        firstDifference = index;
        break;
      }
    }

    return {
      label: "binary",
      result: {
        path,
        written: bytes.length,
        read: readBack.length,
        identical: firstDifference === -1 && readBack.length === bytes.length,
        firstDifference,
        elapsedMs,
      },
    };
  },
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    const run = action ? actions[action] : undefined;
    if (!run) return;

    const name = button.querySelector<HTMLSpanElement>(".call-name");
    const original = name?.textContent ?? "";
    button.disabled = true;
    if (name) name.textContent = "Running…";

    try {
      const { result, label } = await run();
      print(result, "normal", label);
    } catch (error) {
      print(describe(error), "error", action ?? "error");
    } finally {
      button.disabled = false;
      if (name) name.textContent = original;
    }
  });
}

void boot();
