#!/usr/bin/env node
// macOS 交叉编译 Windows NSIS 安装包（cargo-xwin 方案），是 scripts/build-release-windows.mjs
// （Windows 本机 / GitHub Actions 用的 MSVC 方案）的 macOS 变体。
//
// 原理：cargo-xwin 用 clang/lld 链接官方下载的 MSVC CRT + Windows SDK，交叉编译
// aarch64/x86_64-pc-windows-msvc target；安装包用本机 Homebrew 装的 NSIS(makensis) 打。
// tauri.windows.conf.json 会在目标为 Windows 时自动合并（NSIS + WebView2 bootstrapper）。
// arm64 需要 scripts/xwin-clang-shim/ 里的 clang shim（强制 --driver-mode=cl）才能编译
// ring——cc-rs 对 aarch64-msvc 调普通 clang，不认 cargo-xwin CFLAGS 里的 /imsvc 参数。
//
// ⚠️ 官方定位：experimental / 兜底方案
// https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos
// 产物与真 Windows 构建的 NSIS 包一致，但少了真机验证；正式发版仍建议走
// GitHub Actions windows-latest runner（.github/workflows/build-windows.yml）。
//
// 用法（仓库根目录，仅限 macOS 运行）：
//   node scripts/build-release-windows-cross.mjs               # arm64 + x64 都打
//   node scripts/build-release-windows-cross.mjs --arch arm64  # 仅 ARM64
//   node scripts/build-release-windows-cross.mjs --arch x64    # 仅 x64（别名 x86_64）
// 可选环境变量：
//   FUND01_RELEASE_DIR  归档目录（默认 <repo>/release-windows，与 Windows 脚本一致）
//   LLVM_BIN            LLVM bin 目录（默认 /opt/homebrew/opt/llvm/bin，Intel Mac 为 /usr/local/opt/llvm/bin）
//   LLD_BIN             LLD bin 目录（默认 /opt/homebrew/opt/lld/bin；新版 llvm 把 LLD 拆到独立 formula）
//   XWIN_CACHE_DIR      Windows SDK 缓存目录（首次构建会下载约 1GB，可跨项目共享）
//
// 前置（脚本会逐个校验，缺了会给出安装命令）：
//   - brew install nsis llvm lld
//   - rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc
//   - cargo install --locked cargo-xwin
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriConfPath = path.join(root, 'apps/tauri/src-tauri/tauri.conf.json')

if (process.platform !== 'darwin') {
  console.error('此脚本只能在 macOS 上运行；Windows 本机请用 scripts/build-release-windows.mjs')
  process.exit(1)
}

const ARCHES = {
  arm64: { target: 'aarch64-pc-windows-msvc', label: 'Windows on ARM' },
  x64: { target: 'x86_64-pc-windows-msvc', label: 'Windows x64 (Intel/AMD)' },
}
// --arch 别名：与 macOS 脚本的 x86_64 写法互通
const ALIASES = { aarch64: 'arm64', x86_64: 'x64' }

const releaseDir = process.env.FUND01_RELEASE_DIR || path.join(root, 'release-windows')

// LLVM 是 keg-only，二进制不在默认 PATH；Intel Mac 是 /usr/local。
// 新版 llvm 把 LLD 拆到独立 formula（lld 23+，2026-08 实测），lld-link 在 opt/lld/bin。
const homebrewPrefix = os.arch() === 'arm64' ? '/opt/homebrew/opt' : '/usr/local/opt'
const llvmBin = process.env.LLVM_BIN || `${homebrewPrefix}/llvm/bin`
const lldBin = process.env.LLD_BIN || `${homebrewPrefix}/lld/bin`

function run(cmd, extraEnv) {
  console.log(`\n▶ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root, env: extraEnv })
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

// 解析 --arch 参数（与 build-tauri-all.mjs 一致，支持 = 传值）
const archArg = process.argv.find((a) => a.startsWith('--arch='))
  || (process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : null)
const archKey = archArg ? ALIASES[archArg] || archArg : null
const selected = archKey ? { [archKey]: ARCHES[archKey] } : ARCHES
if (!Object.keys(selected).length || Object.values(selected).some((v) => !v)) {
  fail('未知架构，可选：arm64 / x64')
}

const version = JSON.parse(readFileSync(tauriConfPath, 'utf-8')).version
if (!version) fail('无法从 tauri.conf.json 读取 version')

// ---------- 前置校验 ----------
function check(cmd, missingHint) {
  try {
    execSync(cmd, { stdio: 'ignore' })
    return true
  } catch {
    console.error(`✗ 缺少前置：${missingHint}`)
    return false
  }
}

let ok = true
ok = check('cargo xwin --version', 'cargo-xwin 未安装 → `cargo install --locked cargo-xwin`') && ok
ok = check('makensis -VERSION', 'NSIS 未安装 → `brew install nsis`') && ok
ok = check(`test -x '${path.join(llvmBin, 'clang')}' && test -x '${path.join(llvmBin, 'llvm-rc')}'`,
  `LLVM 未安装或缺 llvm-rc → \`brew install llvm\`（已设 LLVM_BIN 可覆盖探测路径：${llvmBin}）`) && ok
ok = check(`test -x '${path.join(lldBin, 'lld-link')}' || test -x '${path.join(llvmBin, 'lld-link')}'`,
  `lld-link 未安装 → \`brew install lld\`（新版 llvm 把 LLD 拆到独立 formula；已设 LLD_BIN 可覆盖探测路径）`) && ok

const installedTargets = execSync('rustup target list --installed', { encoding: 'utf8' })
for (const { target } of Object.values(selected)) {
  if (!installedTargets.includes(target)) {
    console.error(`✗ 缺少 Rust target ${target} → \`rustup target add ${target}\``)
    ok = false
  }
}
if (!ok) process.exit(1)

console.log(`LLVM bin: ${llvmBin}`)
console.log(`LLD bin:  ${lldBin}`)
console.log(`归档目录: ${releaseDir}`)

// clang shim：修复 cargo-xwin 打 aarch64-pc-windows-msvc 时 ring 编译失败
// （cc-rs 调普通 `clang`，不认 CFLAGS 里的 clang-cl 风格 `/imsvc` 参数）。
// 方案来自社区（soldr clang-shim，CROSS_COMPILE.md）：强制 --driver-mode=cl。
// 必须排在 LLVM 之前，否则 cc-rs 会先找到真实 clang。
const shimDir = path.join(root, 'scripts/xwin-clang-shim')

// 构造构建环境：shim + LLD + LLVM 进 PATH（clang-cl / llvm-rc / lld-link 都在这）
const buildEnv = {
  ...process.env,
  PATH: `${shimDir}:${lldBin}:${llvmBin}:${process.env.PATH || ''}`,
  LLVM_BIN: llvmBin,
}

mkdirSync(releaseDir, { recursive: true })

const archived = []
for (const [arch, { target, label }] of Object.entries(selected)) {
  console.log(`\n========== 交叉编译 ${label} 版 (${target}) ==========`)
  run(
    `pnpm --filter @fund01/tauri exec tauri build --runner cargo-xwin --target ${target} --bundles nsis`,
    buildEnv,
  )

  const srcExe = path.join(
    root,
    `apps/tauri/src-tauri/target/${target}/release/bundle/nsis/Fund01_${version}_${arch}-setup.exe`,
  )
  if (!existsSync(srcExe)) {
    console.error(`构建产物缺失：${srcExe}`)
    process.exit(1)
  }

  const dstExe = path.join(releaseDir, path.basename(srcExe))
  copyFileSync(srcExe, dstExe)
  archived.push(dstExe)
  console.log(`\n✓ 已归档：${dstExe}`)
}

// 重新生成 SHA256SUMS.txt（覆盖归档目录里现有全部安装包，sha256sum 格式）
const sumLines = readdirSync(releaseDir)
  .filter((f) => f.endsWith('-setup.exe'))
  .sort()
  .map((f) => {
    const hash = createHash('sha256').update(readFileSync(path.join(releaseDir, f))).digest('hex')
    return `${hash}  ${f}`
  })
writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${sumLines.join('\n')}\n`, 'utf-8')

console.log('\n========== build-release-windows-cross 完成 ==========')
console.log('产物列表：')
for (const [arch, { label }] of Object.entries(selected)) {
  console.log(`  ${path.join(releaseDir, `Fund01_${version}_${arch}-setup.exe`)}  (${label})`)
}
console.log(`  ${path.join(releaseDir, 'SHA256SUMS.txt')}`)
