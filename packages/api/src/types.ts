export interface MioBootstrap {
  port: number;
  token: string;
  apiVersion: string;
  platform: string;
  app: {
    id: string;
    name: string;
    version: string;
  };
}

export type BridgeState = "connecting" | "open" | "closed";

export interface MioBridge {
  readonly __mio: true;
  readonly apiVersion: string;
  readonly platform: string;
  readonly app: { id?: string; name?: string; version?: string };
  readonly ready: Promise<{ apiVersion: string; platform: string; app: Record<string, unknown> }>;
  /** Transport state; changes are reported as the `bridge.state` event. */
  readonly state: BridgeState;
  invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(name: string, handler: (data: unknown) => void): () => void;
  off(name: string, handler: (data: unknown) => void): void;
  once(name: string, handler: (data: unknown) => void): () => void;
  /** Absolute URL of the blob endpoint for a file, usable with fetch(). */
  blobUrl(path: string): string;
  /** Read a file over HTTP (streaming, no base64 overhead). */
  readBlob(path: string): Promise<Uint8Array>;
  /** Write a file over HTTP. */
  writeBlob(path: string, data: ArrayBuffer | ArrayBufferView): Promise<void>;
}

declare global {
  interface Window {
    Mio?: MioBridge;
    __MIO_BOOT__?: MioBootstrap;
  }
}
