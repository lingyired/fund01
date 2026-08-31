#!/usr/bin/env node
// Windows 双架构发布（NSIS 安装包）：arm64 + x64，对应 macOS 版的 scripts/build-release-all.mjs。
// 流程：
//   1. vcvarsall.bat 按「宿主机架构 + 目标架构」初始化 MSVC 环境（ARM64 机上 x64 用 arm64_x64 交叉）
//   2. tauri build --bundles nsis 逐架构构建（tauri.windows.conf.json 自动合并）
//   3. 归档安装包到 release-windows/ 并重新生成 SHA256SUMS.txt
//
// 用法（仓库根目录，仅限 Windows 运行）：
//   node scripts/build-release-windows.mjs               # arm64 + x64 都打
//   node scripts/build-release-windows.mjs --arch arm64  # 仅 ARM64
//   node scripts/build-release-windows.mjs --arch x64    # 仅 x64（别名 x86_64）
// 可选环境变量：
//   FUND01_RELEASE_DIR  归档目录（默认 <repo>/release-windows，与 release-macos/ 对应）
//   FUND01_EXE_SUFFIX   归档文件名后缀（如 -ci：Fund01_1.5.0_x64-ci-setup.exe），
//                       用于区分构建来源（CI / 本机）。默认空，保持 Fund01_<ver>_<arch>-setup.exe
//   LLVM_BIN            追加到 PATH 的 LLVM bin（默认自动探测 %USERPROFILE%\tools\llvm\clang+llvm-*，可选）
//
// 前置：
//   - VS 2022 Build Tools（VC 工具链含 ARM64 组件，能找到 vcvarsall.bat）
//   - rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc
//   - node 22+ / pnpm（Windows 侧 node_modules；Parallels 共享目录里的 macOS 符号链接会让 pnpm 报 EINVAL，建议在本地磁盘副本中构建）
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriConfPath = path.join(root, 'apps/tauri/src-tauri/tauri.conf.json')

if (process.platform !== 'win32') {
  console.error('此脚本只能在 Windows 上运行（需要 vcvarsall.bat 与 MSVC 工具链）')
  process.exit(1)
}

const ARCHES = {
  arm64: { target: 'aarch64-pc-windows-msvc', label: 'Windows on ARM' },
  x64: { target: 'x86_64-pc-windows-msvc', label: 'Windows x64 (Intel/AMD)' },
}
// --arch 别名：与 macOS 脚本的 x86_64 写法互通
const ALIASES = { aarch64: 'arm64', x86_64: 'x64' }

const releaseDir = process.env.FUND01_RELEASE_DIR || path.join(root, 'release-windows')
// 归档名后缀：区分构建来源。CI 传 -ci，本机默认空。
const exeSuffix = process.env.FUND01_EXE_SUFFIX || ''

function run(cmd, extraEnv) {
  console.log(`\n▶ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root, env: extraEnv })
}

// 解析 --arch 参数（与 build-tauri-all.mjs 一致，支持 = 传值）
const archArg = process.argv.find((a) => a.startsWith('--arch='))
  || (process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : null)
const archKey = archArg ? ALIASES[archArg] || archArg : null
const selected = archKey ? { [archKey]: ARCHES[archKey] } : ARCHES
if (!Object.keys(selected).length || Object.values(selected).some((v) => !v)) {
  console.error('未知架构，可选：arm64 / x64')
  process.exit(1)
}

// 版本号从 tauri.conf.json 读（安装包命名 Fund01_<version>_<arch>-setup.exe）
const version = JSON.parse(readFileSync(tauriConfPath, 'utf-8')).version
if (!version) {
  console.error('无法从 tauri.conf.json 读取 version')
  process.exit(1)
}

// 定位 vcvarsall.bat：优先 vswhere，退回常见安装路径
function findVcVarsAll() {
  const candidates = []
  const vsWhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  if (existsSync(vsWhere)) {
    try {
      const out = execFileSync(vsWhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' })
      candidates.push(...out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    } catch { /* vswhere 失败则走静态候选 */ }
  }
  candidates.push(
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community',
  )
  for (const dir of candidates) {
    const vc = path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
    if (existsSync(vc)) return vc
  }
  return null
}

// 宿主机架构决定 vcvarsall 参数：ARM64 机打 x64 用 arm64_x64，x64 机打 ARM64 用 x64_arm64
const hostIsArm = process.arch === 'arm64'
const VCVARS_ARCH = {
  'aarch64-pc-windows-msvc': hostIsArm ? 'arm64' : 'x64_arm64',
  'x86_64-pc-windows-msvc': hostIsArm ? 'arm64_x64' : 'x64',
}

// 可选的 LLVM bin（个别依赖可能用到），默认探测 tools/llvm，找不到就跳过
function findLlvmBin() {
  if (process.env.LLVM_BIN && existsSync(process.env.LLVM_BIN)) return process.env.LLVM_BIN
  const toolsDir = path.join(os.homedir(), 'tools', 'llvm')
  try {
    const hit = readdirSync(toolsDir).find(
      (d) => d.startsWith('clang+llvm-') && existsSync(path.join(toolsDir, d, 'bin')),
    )
    if (hit) return path.join(toolsDir, hit, 'bin')
  } catch { /* 没有 tools/llvm 目录则忽略 */ }
  return null
}

const vcvarsall = findVcVarsAll()
if (!vcvarsall) {
  console.error('找不到 vcvarsall.bat，请确认 VS 2022 Build Tools（含 ARM64 组件）已安装')
  process.exit(1)
}
console.log(`vcvarsall: ${vcvarsall}`)
console.log(`宿主机: ${process.arch}，归档目录: ${releaseDir}`)

const llvmBin = findLlvmBin()
if (llvmBin) {
  console.log(`LLVM bin: ${llvmBin}`)
} else {
  console.log('LLVM bin: 未找到（若依赖需要 clang，请设 LLVM_BIN 环境变量）')
}
const buildEnv = { ...process.env, PATH: `${llvmBin ? `${llvmBin};` : ''}${process.env.PATH || ''}` }

mkdirSync(releaseDir, { recursive: true })

const archived = []
for (const [arch, { target, label }] of Object.entries(selected)) {
  console.log(`\n========== 构建 ${label} 版 (${target}) ==========`)
  run(
    `call "${vcvarsall}" ${VCVARS_ARCH[target]} && pnpm --filter @fund01/tauri exec tauri build --target ${target} --bundles nsis`,
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

  // 归档名可带来源后缀（如 -ci），tauri 原始产物名不变
  const dstName = `Fund01_${version}_${arch}${exeSuffix}-setup.exe`
  const dstExe = path.join(releaseDir, dstName)
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

console.log('\n========== build-release-windows 完成 ==========')
console.log('产物列表：')
for (const [arch, { label }] of Object.entries(selected)) {
  console.log(`  ${path.join(releaseDir, `Fund01_${version}_${arch}${exeSuffix}-setup.exe`)}  (${label})`)
}
console.log(`  ${path.join(releaseDir, 'SHA256SUMS.txt')}`)
