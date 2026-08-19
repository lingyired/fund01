#!/usr/bin/env node
// 双架构 Tauri 打包 + 打 DMG：arm64 (Apple Silicon / M 芯片) + x86_64 (Intel)
// 分架构产出 .app（中间产物）并自动调用 scripts/build-dmg.mjs 打 DMG。
// **发布形态 = DMG**（2026-08-19 定）：release-macos/Fund01_{version}_{arch}.dmg，
// .app 仅作中间产物归档（build-dmg.mjs 也依赖它），不直接对外发布。
// DMG 用 sindresorhus/create-dmg（纯 hdiutil 路径，无需 Finder 权限）。
//
// 用法：
//   node scripts/build-tauri-all.mjs             # 双架构都打（.app + DMG）
//   node scripts/build-tauri-all.mjs --arch arm64    # 仅 M 版
//   node scripts/build-tauri-all.mjs --arch x86_64   # 仅 Intel 版
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release-macos')
const tauriConfPath = path.join(root, 'apps/tauri/src-tauri/tauri.conf.json')

const ARCHES = {
  arm64: { target: 'aarch64-apple-darwin', label: 'Apple Silicon (M 芯片)' },
  x86_64: { target: 'x86_64-apple-darwin', label: 'Intel' },
}

function run(cmd) {
  console.log(`\n▶ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root })
}

// 解析 --arch 参数
const archArg = process.argv.find((a) => a.startsWith('--arch='))
  || (process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : null)
const selected = archArg
  ? { [archArg]: ARCHES[archArg] }
  : ARCHES
if (!Object.keys(selected).length || Object.values(selected).some((v) => !v)) {
  console.error('未知架构，可选：arm64 / x86_64')
  process.exit(1)
}

// 版本号从 tauri.conf.json 读（与 bump 后的实际版本保持一致）
const version = JSON.parse(readFileSync(tauriConfPath, 'utf-8')).version
if (!version) {
  console.error('无法从 tauri.conf.json 读取 version')
  process.exit(1)
}

mkdirSync(releaseDir, { recursive: true })

for (const [arch, { target, label }] of Object.entries(selected)) {
  console.log(`\n========== 构建 ${label} 版 (${target}) ==========`)
  run(`pnpm --filter @fund01/tauri exec tauri build --target ${target} --bundles app`)

  const srcApp = path.join(
    root,
    `apps/tauri/src-tauri/target/${target}/release/bundle/macos/Fund01.app`,
  )
  if (!existsSync(srcApp)) {
    console.error(`构建产物缺失：${srcApp}`)
    process.exit(1)
  }

  // 归档：release-macos/Fund01-{version}-{arch}.app（中间产物，清掉旧同名目录再复制）
  const dstApp = path.join(releaseDir, `Fund01-${version}-${arch}.app`)
  if (existsSync(dstApp)) rmSync(dstApp, { recursive: true, force: true })
  cpSync(srcApp, dstApp, { recursive: true })
  console.log(`\n✓ 已归档（中间产物）：${dstApp}`)

  // 自动打 DMG（发布形态），产出 release-macos/Fund01_{version}_{arch}.dmg
  run(`node scripts/build-dmg.mjs --arch ${arch}`)
}

console.log('\n========== 全部完成 ==========')
console.log('发布产物（DMG）：')
for (const [arch] of Object.entries(selected)) {
  console.log(`  release-macos/Fund01_${version}_${arch}.dmg  (${ARCHES[arch].label})`)
}
console.log('中间产物（.app，调试/复检用）：')
for (const [arch] of Object.entries(selected)) {
  console.log(`  release-macos/Fund01-${version}-${arch}.app`)
}
