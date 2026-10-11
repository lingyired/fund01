#!/usr/bin/env node
// 生成 Tauri updater 清单 latest.json（静态 JSON 模式，见 docs/superpowers/specs/2026-10-11-在线更新自动更新-design.md §4.2）
//
// 核心约束（官方文档明确警告）：Tauri 在比对 version 字段**之前**会校验整个 JSON，
// 所有 platforms 条目必须有效完整 —— 某个平台条目缺失/签名无效会导致**所有平台**的更新检查失败。
// 因此本脚本**只收录本次构建成功的平台**：Windows arm64 目前是 experimental（构建可能失败），
// 失败时不写入清单，x64 用户的更新不受影响。
//
// 用法（仓库根目录）：
//   node scripts/gen-updater-manifest.mjs --out dist-updater \
//     --platform darwin-aarch64 --file release-macos/Fund01.app.tar.gz \
//     --platform windows-x86_64 --file release-windows/Fund01_1.7.0_x64-setup.exe
//
// 参数：
//   --platform <OS-ARCH>   目标键（darwin-aarch64 / darwin-x86_64 / windows-x86_64 / windows-aarch64）
//   --file <路径>          产物路径；同名 .sig 必须与之同目录存在（<file>.sig）
//   --url <地址>           产物下载地址；缺省用 GitHub Release 标准地址拼装
//   --notes <文本>         更新说明（写进 JSON 的 notes 字段）
//   --out <目录>           输出目录（默认 dist-updater）
//
// 注意：pub_date 取本脚本运行时刻（RFC 3339）。清单由 CI 生成，产物刚构建完，时间即发布时间。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GitHub Release 标准下载地址（gh release upload 后的资产路径）
const RELEASE_TAG = process.env.FUND01_RELEASE_TAG || ''
const REPO = process.env.FUND01_REPO || 'lingyired/fund01'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) {
    console.error(`--${name} 缺少值`)
    process.exit(1)
  }
  return v
}

// 解析重复的 --platform / --file / --url 三元组
function parseEntries() {
  const entries = []
  let i = 0
  const argv = process.argv.slice(2)
  while (i < argv.length) {
    if (argv[i] === '--platform') {
      const platform = argv[i + 1]
      let file = null
      let url = null
      // 三元组顺序不固定，向后扫到下一个 --platform 为止
      let j = i + 2
      while (j < argv.length && argv[j] !== '--platform') {
        if (argv[j] === '--file') file = argv[j + 1]
        if (argv[j] === '--url') url = argv[j + 1]
        j += 2
      }
      if (!file) {
        console.error(`--platform ${platform} 缺少 --file`)
        process.exit(1)
      }
      entries.push({platform, file, url})
      i = j
    } else {
      i++
    }
  }
  return entries
}

const version = JSON.parse(
  readFileSync(path.join(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf-8'),
).version
if (!version) {
  console.error('无法从 tauri.conf.json 读取 version')
  process.exit(1)
}

const entries = parseEntries()
// 允许「零 --file 只做合并」：CI 里 macOS 分片可能要并进 Windows 分片，
// 此时 platforms 全靠 --merge 填充，提前退出会静默丢平台。
const hasMerge = process.argv.includes('--merge')
if (!entries.length && !hasMerge) {
  console.error('未提供任何 --platform/--file 或 --merge，跳过生成 latest.json')
  process.exit(0)
}

const notes = arg('notes', '')
// --out 支持绝对路径；相对路径按仓库根解析
const outArg = arg('out', 'dist-updater')
const outDir = path.isAbsolute(outArg) ? outArg : path.join(root, outArg)

const platforms = {}
const skipped = []

for (const {platform, file, url} of entries) {
  const absFile = path.isAbsolute(file) ? file : path.join(root, file)
  const sigFile = `${absFile}.sig`

  // 关键：缺产物或缺签名的平台直接跳过，不写进清单（防止拖累所有平台的更新检查）
  if (!existsSync(absFile)) {
    skipped.push(`${platform}（产物缺失：${path.relative(root, absFile)}）`)
    continue
  }
  if (!existsSync(sigFile)) {
    skipped.push(`${platform}（签名缺失：${path.relative(root, sigFile)}）`)
    continue
  }

  const fileName = path.basename(absFile)
  const downloadUrl = url
    || (RELEASE_TAG
      ? `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${fileName}`
      : `https://github.com/${REPO}/releases/latest/download/${fileName}`)

  platforms[platform] = {
    signature: readFileSync(sigFile, 'utf-8').trim(),
    url: downloadUrl,
  }
}

if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 个平台（不写入清单）:`)
  for (const s of skipped) console.log(`  - ${s}`)
}

// --merge <清单路径...>：把已有的分片清单合并进来。
//
// 为什么需要：CI 里macOS job 与 Windows job 各自生成一份 latest.json 分片
//（macOS 只有 darwin-*，Windows 只有 windows-*），而 Tauri 的清单必须是
// **一份包含全部平台** 的 JSON —— 官方明确说明会在比对 version 之前校验整个文件。
// 缺条目会导致该平台的更新检查失败，所以最后必须合并。
//
// 合并时重新校验：URL 与 signature 必须都存在，version 必须一致（不一致说明
// 混入了不同版本的产物，宁可报错也不要发出去）。
const mergeArgs = process.argv.indexOf('--merge')
if (mergeArgs !== -1) {
  const mergeFiles = process.argv.slice(mergeArgs + 1).filter((a) => !a.startsWith('--'))
  const incoming = []
  for (const mf of mergeFiles) {
    const abs = path.isAbsolute(mf) ? mf : path.join(root, mf)
    if (!existsSync(abs)) {
      console.error(`--merge 文件不存在：${mf}`)
      process.exit(1)
    }
    const j = JSON.parse(readFileSync(abs, 'utf-8'))
    if (j.version !== version) {
      console.error(`版本不一致：${mf} 是 v${j.version}，期望 v${version}`)
      process.exit(1)
    }
    for (const [plat, val] of Object.entries(j.platforms || {})) {
      if (!val?.url || !val?.signature) {
        console.error(`分片 ${mf} 的 ${plat} 缺少 url/signature，拒绝合并`)
        process.exit(1)
      }
      if (platforms[plat]) {
        console.error(`平台重复：${plat} 同时出现在 --file 与 --merge 中`)
        process.exit(1)
      }
      platforms[plat] = val
      incoming.push(plat)
    }
  }
  if (incoming.length) {
    console.log(`\n合并 ${mergeFiles.length} 份分片，新增平台：${incoming.join(', ')}`)
  }
}

// 空检查放在 --merge 之后：合并进来的平台也算数
const platformKeys = Object.keys(platforms)
if (!platformKeys.length) {
  console.error('\n没有任何平台通过校验，拒绝生成清单（生成空清单会导致所有用户更新检查失败）')
  process.exit(1)
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
}

mkdirSync(outDir, {recursive: true})
const outFile = path.join(outDir, 'latest.json')
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

console.log(`\n✓ 已生成 ${path.relative(root, outFile)}`)
console.log(`  版本 v${version}`)
console.log(`  平台 ${platformKeys.join(', ')}`)