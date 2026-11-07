export { MioToolError } from "./errors.js";
export type { MioToolErrorCode, MioToolErrorOptions } from "./errors.js";

export {
  discoverAndroidTools,
  describeAndroidTools,
  type AndroidTools,
  type DiscoverOptions,
} from "./discover.js";

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

export { ensureDebugKeystore, type DebugKeystoreOptions } from "./keystore.js";

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
  type ToolBundleManifest,
  type ToolBundlePlatform,
} from "./tool-bundle.js";

export { run, type ExecOptions, type ExecResult } from "./exec.js";

export { listZipEntries, extractZip, readZipEntry } from "./zip.js";
