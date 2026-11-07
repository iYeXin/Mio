// Writes one per-platform fragment for the tool bundle manifest.
//
//   node scripts/write-tools-fragment.mjs --platform win32-x64 \
//     --tools mio-tools-win32-x64-tools.tar.gz \
//     --jre mio-tools-win32-x64-jre.tar.gz --out manifest-win32-x64.json
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (required) throw new Error(`missing --${name}`)
    return undefined
  }
  return process.argv[index + 1]
}

const platform = arg('platform')
const toolsPath = resolve(arg('tools'))
const jrePath = resolve(arg('jre'))
const out = resolve(arg('out'))

async function describe(path) {
  const info = await stat(path)
  const digest = createHash('sha256').update(await readFile(path)).digest('hex')
  return { file: basename(path), sha256: digest, size: info.size, strip: 0 }
}

const fragment = {
  platform,
  tools: await describe(toolsPath),
  jre: await describe(jrePath),
}

await writeFile(out, `${JSON.stringify(fragment, null, 2)}\n`, 'utf8')
console.log(`fragment: ${out} (${platform})`)
