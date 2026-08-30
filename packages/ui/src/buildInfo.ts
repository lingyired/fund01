// 构建戳（build stamp）读取层。
//
// 四个常量由构建期 rsbuild `source.define` 注入（见各 app 的 rsbuild.config.ts
// 与根 scripts/build-info.mjs）：
//   __BUILD_SHA__    git short SHA（7 位）
//   __BUILD_TIME__   构建时间（本地 YYYY-MM-DD HH:mm）
//   __BUILD_BRANCH__ 当前分支名
//   __BUILD_DIRTY__  工作区是否有未提交改动（boolean）
//
// 开发 / 类型检查（tsc --noEmit）阶段没有注入，用 `typeof` 安全回退到占位值，
// 避免 ReferenceError。rsbuild define 在 build/dev 都会替换这些 token，运行时不会落到回退。

declare const __BUILD_SHA__: string | undefined
declare const __BUILD_TIME__: string | undefined
declare const __BUILD_BRANCH__: string | undefined
declare const __BUILD_DIRTY__: boolean | undefined

export interface BuildInfo {
  /** git short SHA；未注入时为 'dev'，构建环境拿不到 git 信息时为空串 */
  sha: string
  /** 构建时间（本地）；未注入时为空串 */
  time: string
  /** 分支名；未注入或拿不到 git 信息时为空串 */
  branch: string
  /** 工作区是否 dirty */
  dirty: boolean
}

// 构建机没有 git 且读不到 .git 时，注入值为 'unknown'。对外视为「无构建信息」，
// 统一归一为空串，让设置页隐藏对应行，而不是显示「构建 unknown / 分支 unknown」。
function withoutUnknown(value: string | undefined): string {
  return !value || value === 'unknown' ? '' : value
}

export const buildInfo: BuildInfo = {
  sha: typeof __BUILD_SHA__ !== 'undefined' ? withoutUnknown(__BUILD_SHA__) : 'dev',
  time: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '',
  branch: typeof __BUILD_BRANCH__ !== 'undefined' ? withoutUnknown(__BUILD_BRANCH__) : '',
  dirty: typeof __BUILD_DIRTY__ !== 'undefined' ? __BUILD_DIRTY__ : false,
}

export default buildInfo
