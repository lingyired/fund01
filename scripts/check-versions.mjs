// 版本同步校验：确保被分发的产物，其版本号在各来源处一致。
//   - Tauri：tauri.conf.json == Cargo.toml == Cargo.lock(fund01-tauri 条目) 三处必须相等
//   - Chrome：package.json 为唯一来源；若 dist/manifest.json 已构建，则必须与 package.json 一致
// 任一不一致 → 打印差异并以非零退出，可在 bump / 提交前拦截「漏改一处版本号」。
// 用法：node scripts/check-versions.mjs
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const errors = []

function readJson(p) {
  return JSON.parse(readFileSync(path.resolve(root, p), 'utf-8'))
}

/* ── Tauri 三处一致性 ── */
const tauriConf = readJson('apps/tauri/src-tauri/tauri.conf.json')
const cargoTomlRaw = readFileSync(
  path.resolve(root, 'apps/tauri/src-tauri/Cargo.toml'),
  'utf-8',
)
const cargoVersion = cargoTomlRaw.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const cargoLockRaw = readFileSync(
  path.resolve(root, 'apps/tauri/src-tauri/Cargo.lock'),
  'utf-8',
)
const lockMatch = cargoLockRaw.match(
  /\[\[package\]\]\s*\nname = "fund01-tauri"\s*\nversion = "([^"]+)"/,
)
const lockVersion = lockMatch?.[1]

const tauriVersions = {
  'tauri.conf.json': tauriConf.version,
  'Cargo.toml': cargoVersion,
  'Cargo.lock (fund01-tauri)': lockVersion,
}
const tauriVal = Object.values(tauriVersions)
if (new Set(tauriVal).size !== 1) {
  errors.push(
    `Tauri 版本三处不一致：\n` +
      Object.entries(tauriVersions)
        .map(([k, v]) => `    ${k}: ${v ?? '(缺失)'}`)
        .join('\n'),
  )
}

/* ── Chrome：package.json 与已构建的 dist/manifest.json ── */
const chromePkg = readJson('apps/chrome/package.json')
const chromeManifestPath = 'apps/chrome/dist/manifest.json'
if (existsSync(path.resolve(root, chromeManifestPath))) {
  const chromeManifest = readJson(chromeManifestPath)
  if (chromeManifest.version !== chromePkg.version) {
    errors.push(
      `Chrome 版本不一致：\n` +
        `    package.json: ${chromePkg.version}\n` +
        `    dist/manifest.json: ${chromeManifest.version}（重新 build 即可同步）`,
    )
  }
} else {
  // dist 尚未构建属正常（仅改源码未打包），跳过此项
  console.log('· Chrome dist/manifest.json 不存在，跳过 Chrome 一致性校验（build 后建议复查）')
}

/* ── 结果 ── */
if (errors.length > 0) {
  console.error('\n✗ 版本同步校验失败：\n')
  for (const e of errors) console.error('  ' + e + '\n')
  process.exit(1)
}

console.log(
  `\n✓ 版本同步校验通过：Tauri ${tauriConf.version}（三处一致）` +
    `，Chrome ${chromePkg.version}（来源一致）`,
)
