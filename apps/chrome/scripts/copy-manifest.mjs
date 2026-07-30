import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const dist = resolve(root, 'dist')

if (!existsSync(dist)) {
  console.error('[copy-manifest] dist/ 不存在，请先执行 rsbuild build')
  process.exit(1)
}

// 版本号唯一来源：package.json
const pkg = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf-8'),
)

// 1. 复制 manifest.json 并用 package.json 的 version 覆盖，保证两者一致
const manifestSrc = resolve(root, 'manifest.json')
const manifestDest = resolve(dist, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'))
manifest.version = pkg.version
writeFileSync(manifestDest, JSON.stringify(manifest, null, 2))
console.log(`[copy-manifest] manifest.json -> dist/manifest.json (v${pkg.version})`)

// 2. 确保图标存在（public/ 默认会被 rsbuild 复制，这里做兜底）
const iconsSrc = resolve(root, 'public', 'icons')
const iconsDest = resolve(dist, 'icons')
if (existsSync(iconsSrc) && !existsSync(iconsDest)) {
  mkdirSync(iconsDest, {recursive: true})
  cpSync(iconsSrc, iconsDest, {recursive: true})
  console.log('[copy-manifest] public/icons -> dist/icons (兜底)')
}

// 3. 清理多余的 background.html（MV3 SW 不需要 HTML）
const bgHtml = resolve(dist, 'background.html')
if (existsSync(bgHtml)) {
  rmSync(bgHtml)
  console.log('[copy-manifest] 移除多余的 dist/background.html')
}

console.log('[copy-manifest] 完成')
