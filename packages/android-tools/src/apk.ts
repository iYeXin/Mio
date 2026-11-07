import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Buffer } from "node:buffer";
import yauzl from "yauzl";
import yazl from "yazl";
import { patchManifestAxml, type ManifestPatch } from "./axml.js";

export interface InjectApkOptions {
  templateApk: string;
  asar: string;
  output: string;
  manifest: ManifestPatch;
  /** Optional source image used to replace the template's launcher icons. */
  icon?: string;
}

export interface InjectApkResult {
  output: string;
  entries: number;
  asarBytes: number;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  compress: boolean;
}

const SIGNATURE_ENTRY = /^META-INF\/(?:MANIFEST\.MF|.*\.(?:SF|RSA|DSA|EC))$/i;

/**
 * Inject app.asar into a prebuilt Flutter APK and patch its manifest.
 *
 * This intentionally does not sign. The caller must run zipalign + apksigner
 * afterwards (see signApk in @iyexin/mio-android-tools).
 */
export async function injectApk(options: InjectApkOptions): Promise<InjectApkResult> {
  const entries = await readEntries(options.templateApk);
  const asar = await readFile(options.asar);
  if (asar.length === 0) throw new Error("app.asar is empty");

  const manifestEntry = entries.find((entry) => entry.name === "AndroidManifest.xml");
  if (!manifestEntry) throw new Error("template APK has no AndroidManifest.xml");
  manifestEntry.data = patchManifestAxml(manifestEntry.data, options.manifest);

  if (options.icon) {
    await replaceLauncherIcons(entries, options.icon);
  }

  const outputEntries = entries.filter((entry) => {
    if (SIGNATURE_ENTRY.test(entry.name)) return false;
    if (entry.name === "assets/mio/app.asar") return false;
    return true;
  });

  const zip = new yazl.ZipFile();
  for (const entry of outputEntries) {
    zip.addBuffer(entry.data, entry.name, {
      compress: entry.compress,
      mtime: new Date(0),
    });
  }
  zip.addBuffer(asar, "assets/mio/app.asar", {
    compress: true,
    mtime: new Date(0),
  });
  zip.end();

  await pipeline(zip.outputStream, createWriteStream(options.output));
  return {
    output: options.output,
    entries: outputEntries.length + 1,
    asarBytes: asar.length,
  };
}

function readEntries(path: string): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("cannot open APK"));
        return;
      }
      const entries: ZipEntry[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          reject(new Error(`unsupported ZIP compression method: ${entry.compressionMethod}`));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`cannot read ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.push({
              name: entry.fileName.replaceAll("\\", "/"),
              data: Buffer.concat(chunks),
              compress: entry.compressionMethod !== 0,
            });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export { SIGNATURE_ENTRY };

async function replaceLauncherIcons(entries: ZipEntry[], iconPath: string): Promise<void> {
  const { default: sharp } = await import("sharp");
  const icon = await readFile(iconPath);
  const launcher = entries.filter(
    (entry) => entry.name.startsWith("res/") && entry.name.endsWith(".png"),
  );
  for (const entry of launcher) {
    const metadata = await sharp(entry.data).metadata();
    if (!metadata.width || !metadata.height) continue;
    entry.data = await sharp(icon)
      .resize(metadata.width, metadata.height, { fit: "cover" })
      .png()
      .toBuffer();
  }
}
