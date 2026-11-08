import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AndroidTools } from "./discover.js";
import { MioToolError } from "./errors.js";
import { run } from "./exec.js";
import { extractZip, zipDirectory } from "./zip.js";

export interface BuildAppBundleOptions {
  /** Patched, unsigned APK. */
  apk: string;
  /** Final `.aab` path. */
  output: string;
  tools: AndroidTools;
  /** Scratch directory for the proto APK and module zip. */
  workDir: string;
  keystore: string;
  alias: string;
  /** Environment variable holding the keystore password. */
  storePasswordEnv: string;
  /** Defaults to storePasswordEnv. */
  keyPasswordEnv?: string;
  /** Run `bundletool validate` after building. Defaults to true. */
  validate?: boolean;
  log?: (message: string) => void;
  timeoutMs?: number;
}

export interface BuildAppBundleResult {
  output: string;
  size: number;
  verified: boolean;
}

/**
 * `aapt2 convert` yields a proto-format APK; bundletool expects a bundle
 * module instead: manifest/, dex/, res/, lib/, assets/, root/ and resources.pb.
 */
export async function prepareModuleDirectory(
  protoApk: string,
  moduleDir: string,
): Promise<void> {
  await rm(moduleDir, { recursive: true, force: true });
  await extractZip(protoApk, moduleDir);
  await mkdir(join(moduleDir, "manifest"), { recursive: true });
  await mkdir(join(moduleDir, "dex"), { recursive: true });
  await mkdir(join(moduleDir, "root"), { recursive: true });

  const manifest = join(moduleDir, "AndroidManifest.xml");
  await rename(manifest, join(moduleDir, "manifest", "AndroidManifest.xml"));

  for (const entry of await readdir(moduleDir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === "manifest" || name === "dex" || name === "root" || name === "resources.pb") {
      continue;
    }
    if (entry.isDirectory() && (name === "res" || name === "lib" || name === "assets")) {
      continue;
    }
    const from = join(moduleDir, name);
    if (entry.isFile() && name.endsWith(".dex")) {
      await rename(from, join(moduleDir, "dex", name));
      continue;
    }
    await rename(from, join(moduleDir, "root", name));
  }
}

function failure(kind: "AAPT2_FAILED" | "BUNDLETOOL_FAILED" | "JARSIGN_FAILED", result: {
  code: number;
  stdout: string;
  stderr: string;
}, tool: string): MioToolError {
  const text = `${result.stderr}${result.stdout}`.trim();
  const line = text.split(/\r?\n/).find((value) => value.trim().length > 0);
  return new MioToolError(kind, `${tool} failed${line ? `: ${line}` : ""}`, {
    stdout: result.stdout,
    stderr: result.stderr,
    details: `exit code ${result.code}`,
  });
}

/**
 * Builds and signs an Android App Bundle from an already-patched APK:
 *
 *   APK → aapt2 convert → module zip → bundletool build-bundle → jarsigner
 *
 * The APK must be unsigned: a stale META-INF signature would be carried into
 * the module and conflict with the bundle signature.
 */
export async function buildAppBundle(
  options: BuildAppBundleOptions,
): Promise<BuildAppBundleResult> {
  const log = options.log ?? (() => {});
  const { tools } = options;
  if (!tools.aapt2) {
    throw new MioToolError(
      "BUNDLE_NOT_AVAILABLE",
      "aapt2 is not available; install the bundle tool component",
      { details: "Run `mio tools install --platform android --format aab`." },
    );
  }
  if (!tools.bundletoolJar) {
    throw new MioToolError(
      "BUNDLE_NOT_AVAILABLE",
      "bundletool.jar is not available; install the bundle tool component",
      { details: "Run `mio tools install --platform android --format aab`." },
    );
  }
  if (!tools.jarsigner) {
    throw new MioToolError(
      "JARSIGNER_NOT_FOUND",
      "jarsigner is required to sign the bundle",
      { details: "Use the Mio tool bundle JRE (it includes jdk.jartool) or a full JDK." },
    );
  }

  const storePassword = process.env[options.storePasswordEnv];
  if (!storePassword) {
    throw new MioToolError(
      "JARSIGN_FAILED",
      `Environment variable ${options.storePasswordEnv} is not set`,
      { details: "The bundle is signed with the upload key; set the password variable first." },
    );
  }
  const keyPasswordEnv = options.keyPasswordEnv ?? options.storePasswordEnv;
  if (!process.env[keyPasswordEnv]) {
    throw new MioToolError(
      "JARSIGN_FAILED",
      `Environment variable ${keyPasswordEnv} is not set`,
    );
  }

  const protoApk = join(options.workDir, "proto.apk");
  const moduleDir = join(options.workDir, "module");
  const moduleZip = join(options.workDir, "base.zip");
  const timeoutMs = options.timeoutMs ?? 300_000;

  await rm(options.output, { force: true });
  await rm(protoApk, { force: true });
  await rm(moduleZip, { force: true });

  log("aapt2: converting to proto format");
  const convert = await run(
    tools.aapt2,
    ["convert", "--output-format", "proto", "-o", protoApk, options.apk],
    { timeoutMs },
  );
  if (convert.code !== 0) throw failure("AAPT2_FAILED", convert, "aapt2 convert");

  log("module: assembling base module");
  await prepareModuleDirectory(protoApk, moduleDir);
  await zipDirectory(moduleDir, moduleZip);

  log("bundletool: building bundle");
  const build = await run(
    tools.java,
    [
      "-jar",
      tools.bundletoolJar,
      "build-bundle",
      `--modules=${moduleZip}`,
      `--output=${options.output}`,
    ],
    { timeoutMs },
  );
  if (build.code !== 0) throw failure("BUNDLETOOL_FAILED", build, "bundletool build-bundle");

  if (options.validate !== false) {
    log("bundletool: validating bundle");
    const validate = await run(
      tools.java,
      ["-jar", tools.bundletoolJar, "validate", `--bundle=${options.output}`],
      { timeoutMs },
    );
    if (validate.code !== 0) {
      throw failure("BUNDLETOOL_FAILED", validate, "bundletool validate");
    }
  }

  log(`jarsigner: signing with ${options.alias}`);
  const sign = await run(
    tools.jarsigner,
    [
      "-keystore",
      options.keystore,
      "-storetype",
      "PKCS12",
      "-storepass:env",
      options.storePasswordEnv,
      "-keypass:env",
      keyPasswordEnv,
      "-sigalg",
      "SHA256withRSA",
      "-digestalg",
      "SHA-256",
      options.output,
      options.alias,
    ],
    { timeoutMs },
  );
  if (sign.code !== 0) throw failure("JARSIGN_FAILED", sign, "jarsigner");

  const verify = await run(
    tools.jarsigner,
    ["-J-Duser.language=en", "-J-Duser.country=US", "-verify", options.output],
    { timeoutMs },
  );
  const verified = verify.code === 0 && /jar verified/i.test(`${verify.stdout}${verify.stderr}`);
  if (!verified) throw failure("JARSIGN_FAILED", verify, "jarsigner -verify");

  const size = (await stat(options.output)).size;
  return { output: options.output, size, verified };
}
