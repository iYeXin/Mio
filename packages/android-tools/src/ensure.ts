import { MioToolError } from "./errors.js";
import {
  bundleComplete,
  describeMissing,
  inspectAndroidTools,
  statusComplete,
  toolsFromStatus,
  type AndroidTools,
} from "./discover.js";
import {
  installToolBundle,
  type ToolBundleManifest,
  type ToolComponent,
} from "./tool-bundle.js";

export interface EnsureAndroidToolsOptions {
  /** Manifest object, local path, or URL. Required when something is missing. */
  manifest: ToolBundleManifest | string;
  /** Defaults to ~/.mio/tools/android. */
  cacheDir?: string;
  /** Proxy for the tool bundle download; defaults to the standard env vars. */
  proxy?: string;
  /** Re-download every requested component even when cached. */
  force?: boolean;
  /** Set false to fail instead of downloading (offline builds, tests). */
  allowDownload?: boolean;
  /** AAB output also needs aapt2 + bundletool + jarsigner. */
  needBundle?: boolean;
  log?: (message: string) => void;
}

export interface EnsureAndroidToolsResult {
  tools: AndroidTools;
  /** Components fetched in this call; empty when the machine had everything. */
  installed: ToolComponent[];
  downloaded: boolean;
}

/**
 * Resolve a complete Android toolchain, downloading only what is missing.
 *
 * Existing Java or build-tools are reused: a machine with a JDK but no SDK only
 * fetches `tools` (~1.5 MB), one with build-tools but no Java only fetches
 * `jre` (~18 MB).
 */
export async function ensureAndroidTools(
  options: EnsureAndroidToolsOptions,
): Promise<EnsureAndroidToolsResult> {
  const log = options.log ?? (() => {});
  const needBundle = options.needBundle === true;
  const complete = (status: Awaited<ReturnType<typeof inspectAndroidTools>>): boolean =>
    statusComplete(status) && (!needBundle || bundleComplete(status));

  let status = await inspectAndroidTools();
  if (complete(status) && !options.force) {
    return { tools: toolsFromStatus(status), installed: [], downloaded: false };
  }

  if (options.allowDownload === false) {
    throw new MioToolError(
      "ANDROID_TOOLS_NOT_FOUND",
      `Android build tools are incomplete (${describeMissing(status, { bundle: needBundle })})`,
      { details: "Downloading is disabled (MIO_NO_TOOL_DOWNLOAD); install them or allow downloads." },
    );
  }

  const needed: ToolComponent[] = [];
  if (!status.apksignerJar || !status.zipalign) needed.push("tools");
  if (!status.java) needed.push("jre");
  if (needBundle && !bundleComplete(status)) needed.push("bundle");
  // A forced refresh reinstalls everything, even when the machine looks ready.
  if (needed.length === 0) {
    needed.push("tools", "jre");
    if (needBundle) needed.push("bundle");
  }

  log(`${describeMissing(status, { bundle: needBundle })}; fetching ${needed.join(" + ")}`);

  let bundle;
  try {
    bundle = await installToolBundle({
      manifest: options.manifest,
      components: needed,
      cacheDir: options.cacheDir,
      proxy: options.proxy,
      force: options.force,
      log,
    });
  } catch (error) {
    if (
      needBundle &&
      error instanceof MioToolError &&
      /no "bundle" component/i.test(error.message)
    ) {
      throw new MioToolError(
        "BUNDLE_NOT_AVAILABLE",
        `AAB builds are not available for ${process.platform}-${process.arch}`,
        { details: "The tool bundle publishes aapt2/bundletool for Windows x64, Linux x64 and macOS arm64." },
      );
    }
    throw error;
  }

  status = await inspectAndroidTools({
    env: { ...process.env, MIO_ANDROID_TOOLS_DIR: bundle.dir },
  });

  if (!statusComplete(status) || (needBundle && !bundleComplete(status))) {
    throw new MioToolError(
      "ANDROID_TOOLS_NOT_FOUND",
      `Android build tools are still incomplete after installing the bundle (${describeMissing(status, { bundle: needBundle })})`,
      { details: `bundle: ${bundle.dir}` },
    );
  }

  return { tools: toolsFromStatus(status), installed: bundle.installed, downloaded: true };
}
