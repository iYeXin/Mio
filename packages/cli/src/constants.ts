import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** The CLI's own package metadata; `files` does not need to list it, npm always ships it. */
const cliPackage = require("../package.json") as { version: string };

/**
 * Version of the Mio API contract implemented by the bundled templates.
 *
 * Keep this in sync with `mioApiVersion` in the Flutter shell and with the
 * `apiVersion` reported by `@iyexin/mio-api`. Bump the major version only on breaking
 * bridge changes; the shell refuses to load an app requiring a newer major.
 */
export const MIO_API_VERSION = "1.0.0";

/**
 * Version stamped into generated manifests and used to pick the release assets.
 *
 * Read from this package's own `package.json`, so a version bump is a single
 * edit instead of keeping the literal in sync with the file.
 */
export const MIO_CLI_VERSION: string = cliPackage.version;

/** Where release assets (templates, tool bundles) are published. */
export const MIO_RELEASE_BASE = "https://github.com/iYeXin/Mio/releases/download";

/** Packages published to npm under the @iyexin scope. */
export const MIO_API_PACKAGE = "@iyexin/mio-api";

/** Version range written into scaffolds: the API package ships with the CLI. */
export const MIO_API_PACKAGE_VERSION: string = MIO_CLI_VERSION;
