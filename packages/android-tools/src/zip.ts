import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";

/** Lists entry names in a zip, without extracting anything. */
export function listZipEntries(archive: string): Promise<string[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(error ?? new Error(`cannot open ${archive}`));
        return;
      }
      const names: string[] = [];
      zip.on("error", rejectPromise);
      zip.on("entry", (entry) => {
        names.push(entry.fileName.replaceAll("\\", "/"));
        zip.readEntry();
      });
      zip.on("end", () => resolvePromise(names));
      zip.readEntry();
    });
  });
}

/**
 * Extracts a zip into `target`, rejecting entries that escape it.
 *
 * Templates are downloaded archives, so the path check is not optional.
 */
export async function extractZip(archive: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(error ?? new Error(`cannot open ${archive}`));
        return;
      }
      zip.on("error", rejectPromise);
      zip.on("end", () => resolvePromise());
      zip.on("entry", (entry) => {
        const name = entry.fileName;
        if (name.endsWith("/")) {
          mkdir(resolve(target, name), { recursive: true })
            .then(() => zip.readEntry())
            .catch(rejectPromise);
          return;
        }
        const destination = resolve(target, name);
        const contained = relative(target, destination);
        if (contained.startsWith("..") || contained.includes(":")) {
          rejectPromise(new Error(`zip entry escapes the target directory: ${name}`));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            rejectPromise(streamError ?? new Error(`cannot read ${name}`));
            return;
          }
          mkdir(dirname(destination), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(destination)))
            .then(() => zip.readEntry())
            .catch(rejectPromise);
        });
      });
      zip.readEntry();
    });
  });
}

/** Extracts a single entry, or null when it is missing. */
export function readZipEntry(archive: string, wanted: string): Promise<Buffer | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(error ?? new Error(`cannot open ${archive}`));
        return;
      }
      zip.on("error", rejectPromise);
      zip.on("end", () => resolvePromise(null));
      zip.on("entry", (entry) => {
        if (entry.fileName.replaceAll("\\", "/") !== wanted) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            rejectPromise(streamError ?? new Error(`cannot read ${wanted}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", rejectPromise);
          stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
        });
      });
      zip.readEntry();
    });
  });
}

/** Writes a directory into a fresh zip, preserving relative paths. */
export async function zipDirectory(source: string, output: string): Promise<void> {
  const zip = new yazl.ZipFile();

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, name);
      } else if (entry.isFile()) {
        zip.addFile(absolute, name);
      }
    }
  }

  await walk(source, "");
  const done = pipeline(zip.outputStream, createWriteStream(output));
  zip.end();
  await done;
}

export { join as joinPath };
