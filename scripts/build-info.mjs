// 构建戳（build stamp）生成器：供各 app 的 rsbuild.config 注入前端 bundle。
// 捕获 git 信息 + 构建时间，返回 rsbuild `source.define` 所需的「已 JSON.stringify」键值对。
// 注意：rsbuild define 直接把 token 文本替换为给定 JS 代码，故字符串值必须先 JSON.stringify，
// 否则会被当成裸标识符导致 ReferenceError。
// 本文件是纯 .mjs（ESM JS），不得写 TS 类型注解。
import { execSync } from 'node:child_process'

function git(cmd) {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

// 返回四个构建戳常量（值已 JSON.stringify，可直接用于 rsbuild source.define）
export function getBuildDefines() {
  const sha = git('git rev-parse --short HEAD') || 'unknown'
  const branch = git('git rev-parse --abbrev-ref HEAD') || 'unknown'
  const dirty = git('git status --porcelain').length > 0
  return {
    __BUILD_SHA__: JSON.stringify(sha),
    __BUILD_TIME__: JSON.stringify(localStamp()),
    __BUILD_BRANCH__: JSON.stringify(branch),
    __BUILD_DIRTY__: JSON.stringify(dirty),
  }
}

export default getBuildDefines
