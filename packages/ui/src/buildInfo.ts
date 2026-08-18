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
  /** git short SHA；未注入时为 'dev' */
  sha: string
  /** 构建时间（本地）；未注入时为空串 */
  time: string
  /** 分支名；未注入时为空串 */
  branch: string
  /** 工作区是否 dirty */
  dirty: boolean
}

export const buildInfo: BuildInfo = {
  sha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev',
  time: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '',
  branch: typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : '',
  dirty: typeof __BUILD_DIRTY__ !== 'undefined' ? __BUILD_DIRTY__ : false,
}

export default buildInfo
