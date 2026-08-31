import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import path from 'node:path'
import {execSync} from 'node:child_process'

const distDir = path.resolve(process.cwd(), 'dist')
const zipPath = path.resolve(process.cwd(), 'fund01.zip')

if (!existsSync(distDir)) {
  console.error('dist/ 不存在，请先运行 npm run build')
  process.exit(1)
}

// zip -r 对已存在的 zip 是「追加+更新」，不会移除已删除的文件 → 历史版本 CSS/JS 会
// 累积在包里（体积膨胀、可能加载冲突）。打包前先删掉旧包，保证产物只含当前 dist。
if (existsSync(zipPath)) {
  rmSync(zipPath)
}

// 优先用 zip 命令（macOS 自带），否则 fallback 到 node 内置
try {
  execSync(`cd "${distDir}" && zip -r -X "${zipPath}" .`, {stdio: 'inherit'})
  console.log(`✓ 打包完成: ${zipPath}`)
} catch {
  console.error('zip 命令失败，请手动压缩 dist/ 目录')
  process.exit(1)
}

// 同步一份重命名副本到 release-chrome/（与 release-macos / release-windows 归档惯例一致）
// 命名对齐三端惯例：macOS=Fund01_<ver>_<arch>.dmg、Windows=Fund01_<ver>_<arch>-setup.exe、
// Chrome=Fund01_<ver>_chrome.zip（带端标识，无架构，2026-08-31 定）。
// 可选 FUND01_ZIP_SUFFIX：归档名后缀（如 -ci：Fund01_1.5.0_chrome-ci.zip），CI 注入 -ci 与本机区分。
const version = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')).version
const zipSuffix = process.env.FUND01_ZIP_SUFFIX || ''
const releaseDir = path.resolve(process.cwd(), '..', '..', 'release-chrome')
mkdirSync(releaseDir, {recursive: true})
const releaseZip = path.join(releaseDir, `Fund01_${version}_chrome${zipSuffix}.zip`)
copyFileSync(zipPath, releaseZip)
console.log(`✓ 已归档: ${releaseZip}`)
