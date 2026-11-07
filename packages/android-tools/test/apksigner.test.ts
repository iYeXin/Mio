import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignArgs, parseVerifyOutput } from "../src/apksigner.js";

const VERIFY_OUTPUT = `Verifies
Verified using v1 scheme (JAR signing): true
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Verified using v4 scheme (APK Signature Scheme v4): false
Number of signers: 1
Signer #1 certificate DN: CN=Mio Test
Signer #1 certificate SHA-256 digest: 2a9aca5312e2db27e8b227e600d1bd9ce76f3017ec4a5382334c7e1f41d320e6
Signer #1 certificate SHA-1 digest: b6026c011414aa01c55f60d393e0f5ada2ac9892
Signer #1 certificate MD5 digest: 5039b3b2d27eaeee793e04b29850d00c
Signer #1 key algorithm: RSA
Signer #1 key size (bits): 2048
`;

test("parseVerifyOutput parses schemes and certificates", () => {
  const result = parseVerifyOutput(VERIFY_OUTPUT, 0);
  assert.equal(result.verified, true);
  assert.equal(result.v1, true);
  assert.equal(result.v2, true);
  assert.equal(result.v3, true);
  assert.equal(result.v4, false);
  assert.equal(result.signers.length, 1);
  assert.equal(result.signers[0]?.dn, "CN=Mio Test");
  assert.equal(result.signers[0]?.keyAlgorithm, "RSA");
  assert.equal(result.signers[0]?.keySizeBits, 2048);
});

test("parseVerifyOutput marks a failed verification", () => {
  const result = parseVerifyOutput("DOES NOT VERIFY\n", 1);
  assert.equal(result.verified, false);
  assert.equal(result.v1, false);
  assert.equal(result.v2, false);
});

test("parseVerifyOutput handles CRLF", () => {
  const result = parseVerifyOutput(VERIFY_OUTPUT.replace(/\n/g, "\r\n"), 0);
  assert.equal(result.verified, true);
  assert.equal(result.v2, true);
});

test("buildSignArgs keeps passwords out of the command line", () => {
  const args = buildSignArgs({
    input: "in.apk",
    output: "out.apk",
    keystore: "release.p12",
    keystorePassword: "secret",
    keyAlias: "release",
    minSdkVersion: 24,
  });
  assert.deepEqual(args.slice(0, 6), [
    "sign",
    "--ks",
    "release.p12",
    "--ks-key-alias",
    "release",
    "--ks-pass",
  ]);
  assert.equal(args.includes("secret"), false);
  assert.equal(args.includes("env:MIO_KS_PASS"), true);
  assert.equal(args.includes("env:MIO_KEY_PASS"), true);
});

test("buildSignArgs disables v1 for minSdk 24", () => {
  const args = buildSignArgs({
    input: "in.apk",
    output: "out.apk",
    keystore: "release.p12",
    keystorePassword: "secret",
    keyAlias: "release",
    minSdkVersion: 24,
  });
  const index = args.indexOf("--v1-signing-enabled");
  assert.equal(args[index + 1], "false");
});

test("buildSignArgs enables v1 for minSdk 21", () => {
  const args = buildSignArgs({
    input: "in.apk",
    output: "out.apk",
    keystore: "release.p12",
    keystorePassword: "secret",
    keyAlias: "release",
    minSdkVersion: 21,
  });
  const index = args.indexOf("--v1-signing-enabled");
  assert.equal(args[index + 1], "true");
});
