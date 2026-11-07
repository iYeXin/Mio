import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MIO_API_PACKAGE, MIO_API_PACKAGE_VERSION } from "./constants.js";
import {
  cliRoot,
  copyDirectory,
  exists,
  repoRoot,
  safePackageName,
  writeJson,
} from "./project.js";

export interface CreateOptions {
  target: string;
}

export async function createProject(options: CreateOptions): Promise<void> {
  const target = resolve(options.target);
  if (await exists(target)) {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error(`Target is not a directory: ${target}`);
    if ((await readdir(target)).length > 0) {
      throw new Error(`Target directory is not empty: ${target}`);
    }
  }

  const template = await firstExisting([
    join(cliRoot, "templates", "web"),
    join(repoRoot, "templates", "web"),
  ]);

  await copyDirectory(template, target);
  await mkdir(join(target, "src"), { recursive: true });

  // The scaffold depends on the published API package instead of vendoring it:
  // one install step, and upgrades are a normal semver bump.
  const packagePath = join(target, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
  };
  const projectName = safePackageName(basename(target));
  pkg.name = projectName;
  pkg.private = true;
  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    [MIO_API_PACKAGE]: `^${MIO_API_PACKAGE_VERSION}`,
  };
  await writeJson(packagePath, pkg);

  const configPath = join(target, "mio.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    app: { id: string; name: string; version: string };
    android?: Record<string, unknown>;
  };
  config.app.id = `dev.mio.${projectName.replaceAll("-", "_")}`;
  config.app.name = basename(target);
  if (config.android) delete config.android.template;
  await writeJson(configPath, config);

  await writeFile(
    join(target, ".gitignore"),
    ["node_modules/", "dist/", "build/", ".mio/debug.p12", "*.log", ""].join("\n"),
    "utf8",
  );

  console.log(`Created ${target}`);
  console.log("");
  console.log("Next:");
  console.log(`  cd ${basename(target)}`);
  console.log("  npm install");
  console.log(`  npx @iyexin/mio-cli dev --platform windows`);
}

async function firstExisting(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Template not found. Looked in:\n${candidates.join("\n")}`);
}
