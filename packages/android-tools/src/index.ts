export { MioToolError } from "./errors.js";
export type { MioToolErrorCode, MioToolErrorOptions } from "./errors.js";

export {
  discoverAndroidTools,
  describeAndroidTools,
  inspectAndroidTools,
  statusComplete,
  toolsFromStatus,
  describeMissing,
  bundleComplete,
  type AndroidToolStatus,
  type AndroidTools,
  type DiscoverOptions,
} from "./discover.js";

export {
  ensureAndroidTools,
  type EnsureAndroidToolsOptions,
  type EnsureAndroidToolsResult,
} from "./ensure.js";

export {
  alignApk,
  checkAlignment,
  type AlignOptions,
  type AlignmentCheck,
  type PageSize,
} from "./zipalign.js";

export {
  signApkWithApksigner,
  verifyApkWithApksigner,
  buildSignArgs,
  parseVerifyOutput,
  type SignApkWithApksignerOptions,
  type VerifyApkOptions,
  type VerifyResult,
  type SignerCertificate,
} from "./apksigner.js";

export {
  ensureDebugKeystore,
  generateKeystore,
  type DebugKeystoreOptions,
  type KeystoreOptions,
} from "./keystore.js";

export {
  parseAxml,
  patchManifestAxml,
  type AxmlAttribute,
  type AxmlDocument,
  type AxmlElement,
  type ManifestPatch,
} from "./axml.js";

export {
  injectApk,
  type InjectApkOptions,
  type InjectApkResult,
} from "./apk.js";

export {
  injectWindowsExe,
  type InjectWindowsExeOptions,
  type InjectWindowsExeResult,
} from "./windows.js";

export {
  signApk,
  verifyApk,
  type SignApkOptions,
  type SignResult,
} from "./signing.js";

export {
  installToolBundle,
  platformKeyOf,
  type InstallToolBundleOptions,
  type InstalledToolBundle,
  type ToolBundleComponent,
  type ToolBundleManifest,
  type ToolBundlePlatform,
  type ToolComponent,
} from "./tool-bundle.js";

export { run, type ExecOptions, type ExecResult } from "./exec.js";

export { listZipEntries, extractZip, readZipEntry, zipDirectory } from "./zip.js";

export {
  buildAppBundle,
  prepareModuleDirectory,
  type BuildAppBundleOptions,
  type BuildAppBundleResult,
} from "./bundle.js";
