/**
 * Version of the Mio API contract implemented by the bundled templates.
 *
 * Keep this in sync with `mioApiVersion` in the Flutter shell and with the
 * `apiVersion` reported by `@iyexin/mio-api`. Bump the major version only on breaking
 * bridge changes; the shell refuses to load an app requiring a newer major.
 */
export const MIO_API_VERSION = "1.0.0";

/** Version stamped into generated manifests for traceability. */
export const MIO_CLI_VERSION = "0.1.1";

/** Packages published to npm under the @iyexin scope. */
export const MIO_API_PACKAGE = "@iyexin/mio-api";

/** Version range written into scaffolds; matches packages/api's version. */
export const MIO_API_PACKAGE_VERSION = "0.1.1";
