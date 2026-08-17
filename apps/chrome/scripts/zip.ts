import {existsSync, rmSync} from 'node:fs'
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
