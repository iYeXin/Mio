import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { exists } from "./project.js";
import { initProject, scaffoldProject } from "./scaffold.js";

export interface CreateOptions {
  target: string;
}

/**
 * Creates a project.
 *
 * A non-empty directory is initialized in place instead of being replaced:
 * existing files, scripts and dependencies are kept.
 */
export async function createProject(options: CreateOptions): Promise<void> {
  const target = resolve(options.target);
  if (await exists(target)) {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error(`Target is not a directory: ${target}`);
    if ((await readdir(target)).length > 0) {
      const result = await initProject(target);
      printInit(result.target, result.changes, result.packageCreated, true);
      return;
    }
    const result = await scaffoldProject(target);
    printCreated(result.target);
    return;
  }

  const result = await scaffoldProject(target);
  printCreated(result.target);
}

function printCreated(target: string): void {
  console.log(`Created ${target}`);
  console.log("");
  console.log("Next:");
  console.log(`  cd ${basename(target)}`);
  console.log("  npm install");
  console.log("  npm run dev");
}

export function printInit(
  target: string,
  changes: string[],
  packageCreated: boolean,
  existing: boolean,
): void {
  if (changes.length === 0) {
    console.log(`Mio is already set up in ${target}; nothing to change.`);
    console.log("Use `mio upgrade` to move to a newer Mio version.");
    return;
  }
  console.log(
    existing
      ? `Initialized ${target} (existing files were kept)`
      : `Initialized ${target}`,
  );
  for (const change of changes) console.log(`  + ${change}`);
  console.log("");
  console.log("Next:");
  console.log("  npm install");
  if (packageCreated) console.log("  # add your web entry (index.html + vite) before `npm run dev`");
}
