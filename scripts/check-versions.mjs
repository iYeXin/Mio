// Fails when a version number drifted between the places that carry a copy of
// it. The CLI reads its own version from package.json, but the API contract
// version still has to match across languages, and a mismatch is silent until a
// download 404s or a shell refuses to start an app.
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function text(path) {
  return await readFile(new URL(path, root), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

const failures = [];

function expectEqual(label, values) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    failures.push(`${label}: ${unique.map((value) => JSON.stringify(value)).join(" vs ")}`);
    return;
  }
  if (unique[0] === undefined || unique[0] === null || unique[0] === "") {
    failures.push(`${label}: value not found`);
  }
}

function grab(label, source, pattern) {
  const match = source.match(pattern);
  if (!match) {
    failures.push(`${label}: pattern not found`);
    return undefined;
  }
  return match[1];
}

// 1. The packages are published together, so their versions must be identical.
const packageFiles = [
  "package.json",
  "packages/api/package.json",
  "packages/cli/package.json",
  "packages/android-tools/package.json",
];
const packageVersions = [];
for (const file of packageFiles) {
  packageVersions.push((await json(file)).version);
}
expectEqual("package versions", packageVersions);

// 2. The API contract version is mirrored across the shell, the SDK, the CLI and
// the release script, which cannot import each other.
const contractValues = [
  grab(
    "packages/cli/src/constants.ts",
    await text("packages/cli/src/constants.ts"),
    /MIO_API_VERSION\s*=\s*"([^"]+)"/,
  ),
  grab("shell/lib/src/api.dart", await text("shell/lib/src/api.dart"), /mioApiVersion\s*=\s*'([^']+)'/),
  grab(
    "packages/api/src/index.ts",
    await text("packages/api/src/index.ts"),
    /MIO_API_VERSION\s*=\s*"([^"]+)"/,
  ),
  grab(
    "scripts/write-template-manifest.mjs",
    await text("scripts/write-template-manifest.mjs"),
    /API_VERSION\s*=\s*"([^"]+)"/,
  ),
];
expectEqual("API contract version", contractValues);

if (failures.length > 0) {
  console.error("Version check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Versions consistent: CLI ${packageVersions[0]}, API contract ${contractValues[0]}`);
