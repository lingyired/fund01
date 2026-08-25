#!/usr/bin/env node
// 一键签名发布（双架构）：构建 + create-dmg 打 DMG，归档 release-macos/
// 组合复用：
//   1. scripts/build-tauri-all.mjs  → 双架构签名构建 + 归档 .app
//   2. scripts/build-dmg.mjs        → create-dmg 打双架构 DMG + 归档（纯 hdiutil，无需 Finder 权限）
//
// 用法（apps/tauri 下）：
//   pnpm tauri:build:release:all            # 用默认签名身份 Fund01，双架构
//   pnpm tauri:build:release:all --arch arm64   # 仅 M 版
//   APPLE_SIGNING_IDENTITY="xxx" pnpm tauri:build:release:all   # 覆盖签名身份
// 前置：登录钥匙串存在 Fund01 代码签名证书（无证书时自动回退 ad-hoc，仅本机可跑）
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 签名身份：默认 Fund01（自签名发布证书）；可用环境变量覆盖（Tauri 的 APPLE_SIGNING_IDENTITY 优先级高于 tauri.conf.json 的 signingIdentity）
process.env.APPLE_SIGNING_IDENTITY ||= 'Fund01'
console.log(`[build-release-all] 签名身份: ${process.env.APPLE_SIGNING_IDENTITY}`)

// 透传 --arch 参数（如有）给两个子脚本
const archArgs = process.argv.slice(2).join(' ')

function run(cmd) {
  console.log(`\n▶ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root })
}

// 1. 双架构签名构建（arm64 + x86_64）+ 归档 .app
run(`node scripts/build-tauri-all.mjs ${archArgs}`)

// 2. create-dmg 打双架构 DMG + 归档
run(`node scripts/build-dmg.mjs ${archArgs}`)

console.log('\n========== build-release-all 完成 ==========')
console.log('产物：release-macos/Fund01-<version>-{arm64,x86_64}.app')
console.log('      release-macos/Fund01_<version>_{arm64,x86_64}.dmg')
