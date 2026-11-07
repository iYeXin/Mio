// Builds manifest.json for the release assets.
//
// The CLI reads this file to decide which template belongs to the running CLI
// version and to verify each download. Keep the shape in sync with
// packages/cli/src/templates.ts.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API_VERSION = "1.0.0";
const templateVersion = process.env.MIO_TEMPLATE_VERSION ?? "0.1.0";

const files = [
  { key: "android-universal", name: "mio-shell-universal.apk", abi: "universal", kind: "apk" },
  { key: "android-arm64", name: "mio-shell-arm64.apk", abi: "arm64", kind: "apk" },
  { key: "android-x64", name: "mio-shell-x64.apk", abi: "x64", kind: "apk" },
  { key: "windows", name: "mio-windows.zip", kind: "zip" },
];

const manifest = {
  templateVersion,
  apiVersion: API_VERSION,
  builtAt: new Date().toISOString(),
  files: {},
};

for (const file of files) {
  const path = join(process.cwd(), file.name);
  const info = await stat(path);
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  manifest.files[file.key] = {
    name: file.name,
    sha256: hash,
    size: info.size,
    ...(file.abi ? { abi: file.abi } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
  };
}

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`manifest.json: ${Object.keys(manifest.files).join(", ")}`);
