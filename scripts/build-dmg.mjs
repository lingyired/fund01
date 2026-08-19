#!/usr/bin/env node
// 用 sindresorhus/create-dmg（内部 node-appdmg，纯 hdiutil 路径，无需 Finder 自动化权限）
// 打"好看"的双架构 DMG：内置背景图 + 合成卷图标 + app 图标/Applications 链接定位。
// 替代旧的 bundle_dmg.sh --skip-jenkins 朴素版（agent 环境无法跑 Finder AppleScript 美化）。
//
// 用法：
//   node scripts/build-dmg.mjs              # 双架构都打
//   node scripts/build-dmg.mjs --arch arm64    # 仅 M 版
//   node scripts/build-dmg.mjs --arch x86_64   # 仅 Intel 版
//
// 前置：对应架构的 .app 已构建（node scripts/build-tauri-all.mjs --arch xxx）
// 产物：release-macos/Fund01_{version}_{arch}.dmg（去 quarantine）
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, renameSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release-macos')
const tauriConfPath = path.join(root, 'apps/tauri/src-tauri/tauri.conf.json')
const createDmgBin = path.join(root, 'node_modules/.bin/create-dmg')

// arm64 用默认 target（本机直出 target/release/...），x86_64 用交叉 target
const ARCHES = {
  arm64: { app: 'apps/tauri/src-tauri/target/release/bundle/macos/Fund01.app' },
  x86_64: { app: 'apps/tauri/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Fund01.app' },
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

for (const [arch, { app: appRel }] of Object.entries(selected)) {
  const appPath = path.join(root, appRel)
  if (!existsSync(appPath)) {
    console.error(`构建产物缺失：${appPath}\n请先跑 node scripts/build-tauri-all.mjs --arch ${arch}`)
    process.exit(1)
  }

  // 校验 app 版本与 tauri.conf.json 一致
  const appVersion = execSync(
    `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${appPath}/Contents/Info.plist"`,
    { encoding: 'utf-8' },
  ).trim()
  if (appVersion !== version) {
    console.error(`app 版本不匹配：${appPath} = ${appVersion}，tauri.conf.json = ${version}，请重新构建`)
    process.exit(1)
  }

  console.log(`\n========== 打 ${arch} 版 DMG（v${version}）==========`)
  const tmpDir = execSync('mktemp -d /tmp/fund01-dmg.XXXXXX', { encoding: 'utf-8' }).trim()

  // create-dmg 输出文件名固定为 "<AppName> <version>.dmg"，双架构同名，打完立即改名
  run(`${createDmgBin} --no-code-sign --overwrite "${appPath}" "${tmpDir}"`)

  const generated = readdirSync(tmpDir).find((f) => f.endsWith('.dmg'))
  if (!generated) {
    console.error(`create-dmg 未产出 dmg（目录：${tmpDir}）`)
    process.exit(1)
  }

  const finalName = `Fund01_${version}_${arch}.dmg`
  const tmpDmg = path.join(tmpDir, finalName)
  renameSync(path.join(tmpDir, generated), tmpDmg)

  const dstDmg = path.join(releaseDir, finalName)
  cpSync(tmpDmg, dstDmg)
  rmSync(tmpDir, { recursive: true, force: true })

  // 去 quarantine（与 .app 归档惯例一致）
  execSync(`xattr -cr "${dstDmg}"`)
  console.log(`\n✓ 已归档：${dstDmg}`)
}

console.log('\n========== 全部完成 ==========')
console.log('产物列表：')
for (const [arch] of Object.entries(selected)) {
  console.log(`  release-macos/Fund01_${version}_${arch}.dmg`)
}
