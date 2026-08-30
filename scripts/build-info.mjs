// 构建戳（build stamp）生成器：供各 app 的 rsbuild.config 注入前端 bundle。
// 捕获 git 信息 + 构建时间，返回 rsbuild `source.define` 所需的「已 JSON.stringify」键值对。
// 注意：rsbuild define 直接把 token 文本替换为给定 JS 代码，故字符串值必须先 JSON.stringify，
// 否则会被当成裸标识符导致 ReferenceError。
// 本文件是纯 .mjs（ESM JS），不得写 TS 类型注解。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// execFileSync + 参数数组（而非 execSync 字符串 + shell:false）：
// 跨平台行为一致，不依赖 shell 解析，Windows 上也按 PATH 找 git.exe。
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

// git CLI 不可用（未安装 / 不在 PATH）时，直接读 .git 元数据兜底。
// 覆盖「仓库副本保留了 .git，但构建机没有 git 命令」的场景
// （如 Parallels Windows 虚拟机本地磁盘副本里打包）。
// 只解析 HEAD 指向分支 tip 的常见情况；detached HEAD 时 sha 可得、branch 置空；
// 解析不出（如浅克隆且 ref 被 pack 后缺 packed-refs）返回 null。
function readGitDirFallback() {
  try {
    let gitDir = path.join(repoRoot, '.git')
    if (!existsSync(gitDir)) return null
    if (!existsSync(path.join(gitDir, 'HEAD'))) {
      // worktree：.git 是文件，内容为 `gitdir: <真实 git 目录>`
      const pointer = readFileSync(gitDir, 'utf8').trim()
      if (!pointer.startsWith('gitdir:')) return null
      const target = pointer.slice('gitdir:'.length).trim()
      gitDir = path.isAbsolute(target) ? target : path.resolve(repoRoot, target)
      if (!existsSync(path.join(gitDir, 'HEAD'))) return null
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return { sha: head.slice(0, 7), branch: '' } // detached HEAD
    const ref = head.slice(5)
    const branch = ref.replace(/^refs\/heads\//, '')
    let full = ''
    try {
      full = readFileSync(path.join(gitDir, ref), 'utf8').trim()
    } catch {
      // 松散 ref 不存在时查 packed-refs（`<sha> <ref>` 行）
      try {
        const packed = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
        const line = packed.split('\n').find((l) => l.trim().endsWith(` ${ref}`))
        if (line) full = line.trim().split(' ')[0]
      } catch {
        /* ignore */
      }
    }
    return full ? { sha: full.slice(0, 7), branch } : null
  } catch {
    return null
  }
}

function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

// 返回四个构建戳常量（值已 JSON.stringify，可直接用于 rsbuild source.define）。
// git 与 .git 兜底都拿不到时置 'unknown'（前端 buildInfo.ts 会把它归一为「无信息」并隐藏对应行）。
export function getBuildDefines() {
  let sha = git(['rev-parse', '--short', 'HEAD'])
  let branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = git(['status', '--porcelain']).length > 0
  if (!sha || !branch) {
    const fallback = readGitDirFallback()
    if (fallback) {
      sha = sha || fallback.sha
      branch = branch || fallback.branch
    }
  }
  return {
    __BUILD_SHA__: JSON.stringify(sha || 'unknown'),
    __BUILD_TIME__: JSON.stringify(localStamp()),
    __BUILD_BRANCH__: JSON.stringify(branch || 'unknown'),
    __BUILD_DIRTY__: JSON.stringify(dirty),
  }
}

export default getBuildDefines
