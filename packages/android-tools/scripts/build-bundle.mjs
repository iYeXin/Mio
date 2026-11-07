#!/usr/bin/env node
/**
 * Build a Mio Android tools bundle (.tar.gz).
 *
 * Usage:
 *   node scripts/build-bundle.mjs \
 *     --jre <jre-dir> \
 *     --apksigner <apksigner.jar> \
 *     --zipalign <zipalign(.exe)> \
 *     --out <bundle.tar.gz> \
 *     [--platform win32-x64]
 *
 * The archive layout is:
 *   <platform>/apksigner.jar
 *   <platform>/zipalign[.exe]
 *   <platform>/jre/...
 *
 * The printed JSON is the platforms entry to put in a tool-bundle manifest.
 */
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as tar from "tar";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["jre", "apksigner", "zipalign", "out"]) {
  if (!args[required]) {
    throw new Error(`Missing --${required}`);
  }
}

const platform = args.platform ?? `${process.platform}-${process.arch}`;
const stageRoot = await mkdtemp(join(tmpdir(), "mio-bundle-stage-"));
const platformDir = join(stageRoot, platform);
const out = resolve(args.out);

try {
  await mkdir(platformDir, { recursive: true });
  await cp(resolve(args.jre), join(platformDir, "jre"), { recursive: true });
  await copyFile(resolve(args.apksigner), join(platformDir, "apksigner.jar"));
  await copyFile(resolve(args.zipalign), join(platformDir, basename(args.zipalign)));

  await mkdir(dirname(out), { recursive: true });
  await tar.c({ gzip: true, cwd: stageRoot, file: out }, [platform]);

  const data = await readFile(out);
  const entry = {
    platform,
    url: out,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  };
  console.log(JSON.stringify(entry, null, 2));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
