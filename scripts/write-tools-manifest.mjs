// Merges per-platform fragments into mio-tools.json for a release.
//
//   node scripts/write-tools-manifest.mjs --dir tools \
//     --base https://github.com/iYeXin/Mio/releases/download/v0.1.3 \
//     --out mio-tools.json
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (required) throw new Error(`missing --${name}`)
    return undefined
  }
  return process.argv[index + 1]
}

const dir = resolve(arg('dir'))
const base = arg('base').replace(/\/+$/, '')
const out = resolve(arg('out', false) ?? 'mio-tools.json')

const files = (await readdir(dir)).filter((name) => /^manifest-.+\.json$/.test(name))
if (files.length === 0) throw new Error(`no manifest-*.json fragments in ${dir}`)

const platforms = {}
for (const name of files) {
  const fragment = JSON.parse(await readFile(join(dir, name), 'utf8'))
  if (!fragment.platform || !fragment.tools || !fragment.jre) {
    throw new Error(`invalid fragment: ${name}`)
  }
  platforms[fragment.platform] = {
    tools: {
      url: `${base}/${fragment.tools.file}`,
      sha256: fragment.tools.sha256,
      size: fragment.tools.size,
      strip: 0,
    },
    jre: {
      url: `${base}/${fragment.jre.file}`,
      sha256: fragment.jre.sha256,
      size: fragment.jre.size,
      strip: 0,
    },
    ...(fragment.bundle
      ? {
          bundle: {
            url: `${base}/${fragment.bundle.file}`,
            sha256: fragment.bundle.sha256,
            size: fragment.bundle.size,
            strip: 0,
          },
        }
      : {}),
  }
}

const manifest = { schemaVersion: 2, latest: '1', bundles: { '1': { platforms } } }
await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`manifest: ${out} (${Object.keys(platforms).join(', ')})`)
