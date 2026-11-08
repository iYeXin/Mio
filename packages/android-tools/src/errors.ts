export type MioToolErrorCode =
  | "JAVA_NOT_FOUND"
  | "ANDROID_TOOLS_NOT_FOUND"
  | "INVALID_TOOLS_DIR"
  | "MISSING_FILE"
  | "INVALID_ARGUMENT"
  | "SPAWN_FAILED"
  | "TIMEOUT"
  | "APKSIGNER_SIGN_FAILED"
  | "APKSIGNER_VERIFY_FAILED"
  | "ZIPALIGN_FAILED"
  | "KEYSTORE_NOT_FOUND"
  | "KEYTOOL_NOT_FOUND"
  | "KEYTOOL_FAILED"
  | "KEYSTORE_EXISTS"
  | "BUNDLE_DOWNLOAD_FAILED"
  | "BUNDLE_CHECKSUM_FAILED"
  | "BUNDLE_EXTRACT_FAILED"
  | "BUNDLE_NOT_AVAILABLE"
  | "AAPT2_FAILED"
  | "BUNDLETOOL_FAILED"
  | "JARSIGNER_NOT_FOUND"
  | "JARSIGN_FAILED";

export interface MioToolErrorOptions {
  cause?: unknown;
  stdout?: string;
  stderr?: string;
  details?: string;
}

export class MioToolError extends Error {
  readonly code: MioToolErrorCode;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly details?: string;

  constructor(code: MioToolErrorCode, message: string, options: MioToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MioToolError";
    this.code = code;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.details = options.details;
  }
}
