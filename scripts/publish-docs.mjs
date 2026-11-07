// 发布文档站：把 VitePress 的构建产物压缩成 zip，POST 到部署服务器。
//
//   pnpm docs:build && pnpm docs:publish
//
// 配置放在仓库根目录的 .env（不入库，可复制 .env.example）：
//   MIO_DOCS_PUBLISH_API_KEY=...
//   MIO_DOCS_PUBLISH_URL=https://example.com/deploy
//   MIO_DOCS_PATH=docs.example.com/mio/v1/
//
// 只处理中文站点；以后要加语言，把 sites 数组扩成多项即可。
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 .env 解析（KEY=VALUE；# 注释；引号包裹去引号）。 */
function loadEnv(file) {
  if (!existsSync(file)) return {}
  const env = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

const env = loadEnv(join(root, '.env'))
const apiKey = env.MIO_DOCS_PUBLISH_API_KEY || ''
const deployUrl = env.MIO_DOCS_PUBLISH_URL || ''

if (!apiKey) {
  console.error('[publish] Missing MIO_DOCS_PUBLISH_API_KEY in .env')
  process.exit(1)
}
if (!deployUrl) {
  console.error('[publish] Missing MIO_DOCS_PUBLISH_URL in .env')
  process.exit(1)
}

const sites = [
  {
    name: 'cn',
    dist: resolve(root, 'docs', '.vitepress', 'dist'),
    path: (env.MIO_DOCS_PATH || '').trim(),
  },
].filter((site) => site.path)

if (sites.length === 0) {
  console.error(
    '[publish] No site path configured — set MIO_DOCS_PATH in .env (e.g. MIO_DOCS_PATH=docs.example.com/mio/v1/)',
  )
  process.exit(1)
}

/** 压缩 dist 并 POST 到 <deployUrl>?path=<站点路径>。 */
async function publishSite(site) {
  if (!existsSync(site.dist)) {
    console.error(
      `[publish][${site.name}] Build output not found: ${site.dist} — run "pnpm docs:build" first`,
    )
    return false
  }

  const target = `${deployUrl}?path=${site.path}`
  const zipPath = join(tmpdir(), `mio-docs-${site.name}-${Date.now()}.zip`)

  try {
    console.log(`[publish][${site.name}] Zipping ${site.dist} → ${zipPath}`)
    const zip = new AdmZip()
    zip.addLocalFolder(site.dist, '')
    zip.writeZip(zipPath)
    const size = readFileSync(zipPath).length
    console.log(`[publish][${site.name}] Zip size: ${size} bytes`)

    console.log(`[publish][${site.name}] Uploading to ${target}`)
    const form = new FormData()
    form.append('file', new Blob([readFileSync(zipPath)]), basename(zipPath))
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    })
    const body = await res.text()
    if (!res.ok) {
      console.error(`[publish][${site.name}] Deploy failed (HTTP ${res.status}): ${body}`)
      return false
    }
    console.log(`[publish][${site.name}] Deploy OK (HTTP ${res.status}): ${body}`)
    return true
  } catch (error) {
    console.error(`[publish][${site.name}] Deploy error: ${error.message}`)
    return false
  } finally {
    rmSync(zipPath, { force: true })
  }
}

let ok = true
for (const site of sites) {
  if (!(await publishSite(site))) ok = false
}

// 不要用 process.exit()：Windows + Node 24 下，fetch/undici 的句柄仍在关闭中时
// 强制退出会触发 libuv 断言（HTTP 已成功后进程却以非零码结束）。设置 exitCode
// 让事件循环自然排空即可。
process.exitCode = ok ? 0 : 1
