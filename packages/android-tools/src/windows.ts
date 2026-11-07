import { readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import pngToIco from "png-to-ico";
import { NtExecutable, NtExecutableResource, Resource, Data } from "resedit";

export interface InjectWindowsExeOptions {
  templateExe: string;
  asar: string;
  output: string;
  resourceName?: string;
  language?: number;
  appName?: string;
  version?: string;
  /** Optional PNG used to replace the executable's icon group. */
  icon?: string;
}

export interface InjectWindowsExeResult {
  output: string;
  asarBytes: number;
}

/**
 * Inject app.asar as an RT_RCDATA resource into a Windows executable.
 *
 * The Flutter shell reads it with FindResourceW/LoadResource. This does not
 * sign the executable; Authenticode must be applied after injection.
 */
export async function injectWindowsExe(
  options: InjectWindowsExeOptions,
): Promise<InjectWindowsExeResult> {
  const exeBuffer = await readFile(options.templateExe);
  const asar = await readFile(options.asar);
  if (asar.length === 0) throw new Error("app.asar is empty");

  const executable = NtExecutable.from(exeBuffer, { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const bin = asar.buffer.slice(asar.byteOffset, asar.byteOffset + asar.byteLength) as ArrayBuffer;

  resources.replaceResourceEntry({
    type: 10, // RT_RCDATA
    id: options.resourceName ?? "MIO_ASAR",
    lang: options.language ?? 1033,
    codepage: 0,
    bin,
  });

  if (options.appName || options.version) {
    const versions = Resource.VersionInfo.fromEntries(resources.entries);
    const oldEntries = resources.entries.filter((entry) => entry.type === 16);
    for (const version of versions) {
      if (options.version) {
        version.setFileVersion(options.version, 1033);
        version.setProductVersion(options.version, 1033);
      }
      if (options.appName) {
        const values = {
          ProductName: options.appName,
          FileDescription: options.appName,
        };
        version.setStringValues({ lang: 1033, codepage: 1200 }, values, true);
        // Some Windows shell APIs read the legacy ANSI table in preference to
        // the Unicode table. Keep both tables in sync.
        version.setStringValues({ lang: 1033, codepage: 1252 }, values, true);
      }
      if (options.version) {
        const values = {
          FileVersion: options.version,
          ProductVersion: options.version,
        };
        version.setStringValues({ lang: 1033, codepage: 1200 }, values, true);
        version.setStringValues({ lang: 1033, codepage: 1252 }, values, true);
      }
    }
    for (const entry of oldEntries) {
      resources.removeResourceEntry(16, entry.id, entry.lang);
    }
    for (const version of versions) {
      version.outputToResourceEntries(resources.entries);
    }
  }

  if (options.icon) {
    const ico = await pngToIco(options.icon);
    const iconFile = Data.IconFile.from(ico);
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
    const group = groups[0];
    if (group) {
      Resource.IconGroupEntry.replaceIconsForResource(
        resources.entries,
        group.id,
        group.lang,
        iconFile.icons.map((item) => item.data),
      );
    }
  }

  resources.outputResource(executable);

  const generated = executable.generate();
  await writeFile(options.output, Buffer.from(generated));
  return { output: options.output, asarBytes: asar.length };
}
