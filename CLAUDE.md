# CLAUDE.md — fund01 开发指南

你是一位精通 Chrome Extension (MV3)、TypeScript、React、pnpm workspaces、Tauri 2 的工程师。你写可维护、高性能的代码。本文档指导你在 `fund01` monorepo 中进行开发与扩展。

## 项目目标

`fund01` 是一个基金/组合盯盘工具的 monorepo，目标支持多个运行时：

- **apps/chrome**：Chrome 扩展（popup + badge 模式），MV3 Service Worker 后端定时刷新
- **apps/tauri**（未来）：Tauri 2 桌面应用（macOS menubar app），Rust 后端常驻

共享代码在 `packages/`：

- `@fund01/core` — 纯业务逻辑 + 接口契约（DataPort / ConfigPort / EventPort）
- `@fund01/services` — 数据请求层（原生 fetch）
- `@fund01/ui` — React 组件（无运行时耦合，通过 PortsContext 接受 Port 实现）

## 目录保护规则

- **严禁修改** `node_modules/`、`dist/`、`pnpm-lock.yaml`（除非依赖变更）
- 所有新增、修改、重构工作在 `packages/`、`apps/`、根配置文件、`docs/` 中进行
- 如果需要参考原始实现，`wzk-fund` 仓库（`/Users/lingsmbp/Documents/github/wzk-fund`）的 `server/`、`web/`、`chrome/` **只读查阅**，不要使用 Edit/Write 修改它们
- 迁移代码时，从原仓库读取后，在 `fund01/` 对应位置重新实现

## 命令

```bash
pnpm install          # 安装依赖
pnpm dev:chrome       # 启动 Chrome 扩展开发模式（rsbuild --watch）
pnpm build:chrome     # 构建生产版本到 apps/chrome/dist/
pnpm zip:chrome       # 打包 Chrome 扩展为可上传 Web Store 的 zip
pnpm typecheck        # 全仓库递归 TypeScript 类型检查
node scripts/build-tauri-all.mjs            # 双架构 Tauri 打包（arm64 + x86_64，见「双架构发布产物」）
node scripts/build-tauri-all.mjs --arch arm64   # 仅 Apple Silicon 版
node scripts/build-tauri-all.mjs --arch x86_64  # 仅 Intel 版
pnpm --filter @fund01/tauri tauri:build:release:all   # ⭐ 发 GitHub Release 专用：双架构签名构建 + create-dmg 打 DMG（见「双架构发布产物」）
```

**Windows 安装包不在 macOS 上构建**（见「Windows 发布产物」）：本地跑 `node scripts/build-release-windows.mjs` 会被脚本的平台校验挡下；要走 GitHub Actions `.github/workflows/build-windows.yml`（windows-latest runner 原生构建）。

加载扩展：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/chrome/dist/`。

## 版本号与构建戳规则

Fund01 是 pnpm monorepo，含两个被分发的产物与若干内部包。**发布版本号**与**构建戳**是两个不同职责，必须分开对待。

### 产物与版本归属
- **Chrome 扩展**（`apps/chrome`）：版本来源 `apps/chrome/package.json` 的 `version`；构建脚本 `scripts/copy-manifest.mjs` 会把它覆盖到 `dist/manifest.json`（**不要只改 manifest.json**）。UI 经 `chromeWindowPort.getVersion()` 读 `chrome.runtime.getManifest().version`。
- **Tauri 桌面端**（`apps/tauri`）：版本来源 `tauri.conf.json` 与 `Cargo.toml` 必须一致（含 `Cargo.lock` 的 `fund01-tauri` 条目，只改该条目）。UI 经 `tauriWindowPort.preloadVersion()` → Rust `get_version` 命令。
- **内部包**（`packages/core`、`packages/ui`、`packages/services`）：纯 workspace 内部包，不单独发布，`dependencies` 均为 `workspace:*`。其 `package.json` 的 `version` 仅为 pnpm 占位，**发布流程不依赖其值，无需主动 bump**；版本真相是 git commit。

### 统一版本号（共享，2026-08-24 起）
Chrome 与 Tauri **共用同一个版本号**（基线 1.3.0）。任何一次发布——无论只改 Chrome、只改 Tauri、还是改了共享 `packages/*`——版本都两端同步 +1；即使本次改动只落在某一端，下次另一端需要更新时版本号也已对齐。用户看到的 Chrome 与桌面端始终是同一个版本，不存在「chrome-only / tauri-only」的独立版本号。

### 语义化版本（SemVer）
`MAJOR.MINOR.PATCH`：
- `PATCH`：修复 / 小幅改动，准备 commit/push 时 +1
- `MINOR`：一个功能或一批相关改动
- `MAJOR`：保留（预发布阶段暂不使用）
- 预发布基线已重置为 **1.0.0**（2026-08-18 落地：Chrome 1.2.80→1.0.0、Tauri 1.0.50→1.0.0，无历史包袱，重新计数）
- **2026-08-24 起双端统一版本号，基线 **1.3.0**：最后一次分叉为 Chrome 1.0.8 / Tauri 1.2.3，此后 Chrome 与 Tauri 不再各自计数，所有 bump 两端同步 +1。

### MINOR / PATCH 判定（怎么决定）
Fund01 是预发布、自用型 app（使用者即你自己），没有外部 API 消费者，因此**不按「是否向后兼容」分，而按「用户可感知的能力是否新增」分**：

- **PATCH**：改正 / 优化**已有**行为，没有新增用户可感知的能力。
  - bug 修复（popup 加载态、计算/缓存错误）
  - 视觉 / 文案微调（涨跌色值、间距、说明文字）
  - 性能 / 兜底逻辑改进（用户看不见机制变化，行为不变）
  - 内部重构（无用户可见变化）
- **MINOR**：新增用户可感知的能力，或一批相关改动收口成一个可命名的功能里程碑。
  - 新功能 / 新界面（指数 / 市场面板、持仓分组排序、新数据源选项）
  - 新设置项 / 新用户可控行为
- **MAJOR**：保留不用。未来若用，仅限破坏性变更（配置格式不兼容且无法自动迁移、数据存储结构重大变更、产品定位大改）。

**决策口诀**：打开后「能不能做一件之前做不到的事？」能 → MINOR；不能（只是之前能做的更对 / 更好 / 不崩）→ PATCH。**拿不准默认 PATCH**（保守），等一个功能分支整体做完、想给它一个里程碑时再 MINOR。

**MINOR / PATCH 由 AI agent 在 commit/push 时自行判定并 bump**（用户已授权 agent 拍板，无需用户逐次确认）。Agent 按本节的「用户可感知能力是否新增」标准判断：纯修复 / 优化 / 重构 → PATCH；新增用户可控能力 / 可命名功能里程碑 → MINOR；**版本号两端必须一起 +1（统一版本号）**。关键：bump 在「改动完成、准备 commit/push」时一次定，不中途纠结。

**本项目实例参照（分类，具体号随基线重置后重新计数）**：popup 加载态修复 / 涨跌色值微调 / 缓存 bug = PATCH；持仓分组排序、指数 / 市场面板、QDII 夜盘刷新 = MINOR。

### Bump 纪律（统一版本号，2026-08-24 起）
- **发布版本只在「改动完成、准备 commit/push」时 bump 一次，不在每次中间尝试时 bump。**
- **任何改动（chrome-only / tauri-only / 共享包）都两端同步 +1**：`apps/chrome/package.json` 与 Tauri 三处（`tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 的 fund01-tauri 条目）必须全部改为同一新版本。
- 严禁「只 bump 一端」；提交前必须跑 `pnpm check:versions`（已实现两端相等校验）。

### 构建戳（build stamp，已实现）
- **发布版本不负责「我测的是不是刚编的最新版」——那由构建戳承担。**
- **内容字段**：git short SHA（7 位）+ 构建时间（本地 `YYYY-MM-DD HH:mm`）+ 分支名 + 工作区状态（干净 / 有未提交改动）。
- **实现（无需改 Rust / WindowPort）**：SHA 等由**前端构建脚本**在构建期捕获并注入 bundle——Chrome 与 Tauri 共用同一套：
  1. `scripts/build-info.mjs`：`getBuildDefines()` 用 git 捕获四个值，返回已 `JSON.stringify` 的 `source.define` 键值对（`__BUILD_SHA__` / `__BUILD_TIME__` / `__BUILD_BRANCH__` / `__BUILD_DIRTY__`）。
  2. `apps/chrome/rsbuild.config.ts` 与 `apps/tauri/rsbuild.config.ts`：在 `source.define` 接入 `getBuildDefines()`（注意：rsbuild define 直接文本替换 token，字符串值必须先 `JSON.stringify`，否则运行时 ReferenceError）。
  3. `packages/ui/src/buildInfo.ts`：用 `declare const` 声明四个 token，并以 `typeof` 安全回退（`tsc` 类型检查 / dev 未注入时回退 `'dev'/''/''/false`）；导出 `buildInfo` 供共享 UI 使用。
- **展示位置（两层，满足「一瞥即知」与「查完整信息」）**：
  1. **设置页 header（常驻）**：在 `v{version}` 右侧追加 SHA，格式 `v1.0.0 · a1b2c3d`（mono 11px muted，见 `OptionsApp.tsx`）。
  2. **关于 tab（完整明细）**：`关于` 页新增「版本与构建」块，分行展示 版本 / 构建 / 时间 / 分支 / 工作区（工作区 dirty 时显「有未提交改动」并以 `text-gold` 提示）。

### 版本同步校验（已实现，bump 前必跑）
- 脚本 `scripts/check-versions.mjs`，根 `package.json` 暴露为 `pnpm check:versions`。
- 校验 **两端统一**：`apps/chrome/package.json` == `tauri.conf.json`；不一致非零退出（统一版本号铁律）。
- 校验 **Tauri 三处一致**：`tauri.conf.json` == `Cargo.toml` == `Cargo.lock`（fund01-tauri 条目）；不一致非零退出。
- 校验 **Chrome 来源一致**：`dist/manifest.json`（若已构建）必须与 `apps/chrome/package.json` 的 version 相等（否则重新 build 即可，copy-manifest 会自动同步）。
- **Agent 在 bump 版本 / commit 前必须运行 `pnpm check:versions`**，拦截「漏改一处版本号 / Cargo.lock 不同步 / 两端不一致」。

### 双架构发布产物（2026-08-18 定，分开发布非 Universal 单包）
- **产物策略**：Intel 版与 Apple Silicon 版**分开打包、分开下载**，不做 Universal 单包（单包 = 双份二进制 ≈ 体积翻倍，装的时候只用一半，白占磁盘）。
- **最低系统版本（硬性，勿降）**：`bundle.macOS.minimumSystemVersion = "13.0"`（tauri.conf.json 已配，写入 Info.plist 的 `LSMinimumSystemVersion`）。**背景**：UI 基于 Radix Themes 3.x，其 CSS 需要 Safari 15.4+（`@layer`/`:has()`/`dvh`）与 Safari 16.2+（`color-mix()` 110 处）；macOS 11/12 的 WKWebView 不支持 → 样式整块被跳过 → popup/设置界面白屏（2026-08-18 真机诊断）。低于 13.0 的系统由安装器直接拒绝，不出现白屏。
- **⭐ GitHub Release 发布命令（2026-08-25 定，发版必须用它）**：`pnpm --filter @fund01/tauri tauri:build:release:all`
  - 一键完成：双架构签名构建（arm64 + x86_64）→ 归档 `.app` → create-dmg 打双架构 DMG，全部落 `release-macos/`。
  - **签名**：脚本自动注入 `APPLE_SIGNING_IDENTITY="Fund01"`（自签名代码签名证书，钥匙串中 CN=Fund01），产物 `Authority=Fund01`。用户下载安装后提示「Apple 无法验证…恶意软件」→ 系统设置 → 隐私与安全性 → **仍要打开**（软拦截可放行，替代旧的「已损坏」硬拦截 + xattr 绕过）。
  - `tauri.conf.json` 的 `signingIdentity: "-"`（ad-hoc 兜底）保证**任何机器 clone 后都能构建**；发版才用 env 覆盖为 Fund01。别人跑 `pnpm tauri:build:release:all` 无证书会失败，属预期（只有发布者跑）。
  - 底层：`scripts/build-release-all.mjs`（编排）→ `scripts/build-tauri-all.mjs`（构建+归档 .app）→ `scripts/build-dmg.mjs`（create-dmg 打 DMG，纯 hdiutil 无 Finder 依赖）。
- **前置条件**：`rustup target add aarch64-apple-darwin x86_64-apple-darwin`（本机已装，换机需补）；钥匙串存在 Fund01 代码签名证书（无证书回退 ad-hoc，仅本机可跑）。
- **Node 版本坑（create-dmg 依赖 macos-alias 原生模块）**：原生模块按编译时的 Node ABI 绑定。用户终端是 nvm Node 24（ABI 137），若报 `NODE_MODULE_VERSION` 不匹配 / `ERR_DLOPEN_FAILED`，跑 `PATH="/Users/lingsmbp/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm rebuild macos-alias` 修复（在用户实际 Node 版本下重编译）。**WorkBuddy agent 环境（node 22.22.2，2026-08-26 实测）**：直接 `pnpm rebuild macos-alias`（用当前 node 重编译）即可，无需 nvm PATH 覆盖；重编译后再跑 build-dmg.mjs。
- **DMG 例外（已过时，勿按旧文操作）**：旧 bundle_dmg.sh 在 agent 环境因 Finder 权限 -10004 必失败；**2026-08-25 起改用 `scripts/build-dmg.mjs`（纯 create-dmg --no-code-sign + hdiutil，无 Finder 依赖），agent 环境实测可用**（2026-08-26 v1.4.0 双架构 DMG 在 WorkBuddy 环境打出成功）。
  其中 `<staging>` 为拷入对应架构 `Fund01.app` 的临时目录；输出 `Fund01_{version}_{arch}.dmg`（DMG 命名天然带架构后缀，与 .app 命名规则一致）。
- **产物验证**：归档后 `lipo -info Fund01-{version}-{arch}.app/Contents/MacOS/fund01-tauri` 应分别显示 `arm64` / `x86_64`；`codesign -dv` 应显示 `Authority=Fund01`；`spctl -a -vv -t exec` 应为 `rejected / origin=Fund01`（软拦截标志，发版前必查）。
  - 签名身份核查注意：`security find-identity -v -p codesigning` 的 **Valid identities only** 里**看不到** Fund01（自签名证书标记 `CSSMERR_TP_NOT_TRUSTED`），只有 **Matching identities** 里才有。**别据此误判证书丢失**——codesign 按名字直接指定仍可签，以产物 `Authority=Fund01` 为准（2026-08-31 v1.5.0 已验证）。

### Windows 发布产物（2026-08-31 定，macOS 本机无法交叉构建）
- **为什么不能在 macOS 上打**：链接需要 MSVC 的 `link.exe` + Windows SDK 导入库（kernel32.lib / user32.lib 等微软专有文件），打包还需要 `makensis`(NSIS)。rustup 虽可装 `x86_64-pc-windows-msvc` 的 std，但缺链接器与 SDK，交叉不可行；GNU(`-pc-windows-gnu` + mingw) 路径 Tauri 未正式支持，webview2 / windows-rs 大概率链接失败。
- **⭐ 走 GitHub Actions**：`.github/workflows/build-windows.yml`（windows-latest runner 原生跑 `scripts/build-release-windows.mjs`）。触发 = 手动 `workflow_dispatch`（可选 all / x64 / arm64）或 push tag `v*`；产物**只上传 artifact**（30 天保留），**不自动建 Release**——下载校验后手动建，或另接 `softprops/action-gh-release`。
- **matrix 设计**：x64 必成；arm64 依赖 VS 的 ARM64 交叉工具（`x64_arm64`，runner 镜像可能未带该组件）→ 标 `continue-on-error: true` + `fail-fast: false`，单架构可用也好过全红，summary 会标出结果。
- 脚本本身的前置与坑见 `scripts/build-release-windows.mjs` 头部注释（vcvarsall / VS ARM64 组件 / Parallels 共享目录符号链接导致 pnpm EINVAL，须在虚机本地磁盘副本构建）。
- 历史产物留在 `release-windows/`（v1.4.0 双架构 exe + SHA256SUMS.txt），由用户在 Windows 端本地构建产出。

**用法回顾**：测时看 header 的 SHA 是否等于刚构建那次，判断是否为遗留版；push 前后看 `version` 是否同一发布。dirty 为真时说明运行的二进制混入了未提交改动，不等同于任何 commit。

## 更新日志撰写规范（给用户看）

> 从 **v1.0.4（Chrome）/ v1.1.4（Tauri）** 起执行；**v1.3.0 起 Chrome 与 Tauri 统一版本号**，日志一条目对应一个版本。日志文件：`CHANGELOG.md`。

- **受众是最终用户，不是开发记录**：用户关心「这个版本我能感觉到什么变化 / 对我有什么影响」，不关心实现路径、重构、构建流程、调试过程。
- **从产品 / 用户视角写**：用用户能懂的语言描述「改了什么、带来什么体验变化」，不写内部机制。
- **粒度与措辞**：
  - **修复类**：直接说「修复 xx 问题 / 修复 xx 场景下的 xx 现象」。禁止写「修复了 xxx 模块的 xxx bug」「调整了 xxx 函数 / 调用链」这类开发过程。
  - **新增 / 优化类**：写用户获得的新能力或可感知的体验提升（如「新增多分组管理」「关于页补充了联系方式」），不写内部实现。
  - **内部重构 / 性能 / 兜底逻辑**等用户不可感知的改动：**通常不单列**；只有当它解决了用户可感知的问题时，才只写用户侧结果。
- **不要列**：commit 列表、文件改动清单、调试过程、构建戳（SHA / 分支 / dirty）、技术栈细节、agent 自述。
- **版本对应**：Chrome 与 Tauri 统一版本号（2026-08-24 起，基线 1.3.0），更新日志一条目对应一个版本，无需再并列两端版本。

## Tauri macOS dev/release 隔离规则（bundle id / name 区分，铁律）

> **背景坑（2026-08 实测 + 参考 [macOS 26 Control Center trackedApplications ghost 分析](https://b-log.to/tech-analysis/macos-26-controlcenter-trackedapplications-ghost/)）**：macOS 26 之后，System Settings > Menu Bar 的「Allow in the Menu Bar」状态**不是 app 自己控制的**，而是由 Control Center 维护（`~/Library/Group Containers/group.com.apple.controlcenter/Library/Preferences/group.com.apple.controlcenter.plist` 的 `trackedApplications`，按 **bundle id** 记忆每个第三方 menubar app 的可见性）。已知 bug：**旧 app 的 blocked 记录可能残留并覆盖当前 app 自己的 allowed 记录**（表现：`NSStatusItem VisibleCC Item-0 = 0`），导致 app 明明启动了、代码也建了 status item，右上角就是不出现，从代码里查不出任何错。

**规则**：
1. **dev debug 与 release 必须用不同的 bundle id 和 app name**（后缀 `dev`），使 dev 与 release 的 Control Center 记忆 / `~/Library/Application Support/<identifier>` 数据目录 / defaults 域彻底隔离、互不污染：
   - **dev**：`pnpm --filter @fund01/tauri tauri:dev`（读 `apps/tauri/src-tauri/tauri.conf.dev.json`）→ `productName: Fund01-dev`、`identifier: com.lingyi.fund01.dev`
   - **release**：`pnpm --filter @fund01/tauri tauri:build`（读 `tauri.conf.json`）→ `productName: Fund01`、`identifier: com.lingyi.fund01`
   - 禁止把 dev 配置的 bundle id 改回与 release 相同。
2. **打开 app 后 menubar 没出现时，按此顺序排查（先别改代码）**：
   - 确认代码确实创建了 status item（启动日志正常）；
   - 去 **系统设置 → 菜单栏**（Menu Bar / Control Center 相关设置）里找到该 app，**关闭再重新开启「允许在菜单栏」**，让 Control Center 重新认一次这个 bundle id；
   - 检查 app 自己的 defaults 域有无异常：`defaults read com.lingyi.fund01 | rg 'NSStatusItem|VisibleCC'`（dev 换 `com.lingyi.fund01.dev`）；
   - 严重时可备份后清除 Control Center 的 `trackedApplications` 重建 allow-list（需完整磁盘访问权限，**必须先备份** `group.com.apple.controlcenter.plist`，勿整文件乱删）；
   - **以上都不行**：换一个新的 bundle id 重新打包排查（如 dev 换 `com.lingyi.fund01.dev2`，或 release 换 `com.lingyi.fund01b`）——新 id 让 Control Center 彻底重新认这个 app，绕过旧的 blocked 记忆。

## 架构总览

详见 `ARCHITECTURE.md`。要点：

1. **后端权威**：合并计算在 SW（Chrome）/ Rust（Tauri），UI 是被动视图
2. **三个 Port 接口**：UI 通过 `DataPort` / `ConfigPort` / `EventPort` 与具体运行时解耦
3. **源码直引**：app 通过 tsconfig `paths` + rsbuild `resolve.alias` 引用 packages 源码，packages 不单独构建，无需预构建产物

依赖方向：

```
packages/core  ◀── packages/services
              ◀── packages/ui
              ◀── apps/chrome（同时依赖 services + ui）
```

`core` 不依赖任何 `@fund01/*` 包；`services` 和 `ui` 依赖 `core`；`apps/chrome` 依赖三者并注入 Port 实现。

## ⚠️ Chrome 与 Tauri 数据一致性铁律（跨端对齐，最高优先级）

> **信任红线**：用户同时用 Chrome 扩展和 Tauri 桌面端盯同一组持仓、选同一数据源时，**同一时刻两端显示的「当日收益 / 收益率 / 单只涨跌」必须完全一致**。任何一端偏高/偏低都是严重 Bug，会直接摧毁用户对数据的信任。（2026-08-13 已踩坑：自算估值偶发失败时 Tauri 端当日收益比 Chrome 端少约 ¥479，且手动刷新救不回。）

两条独立实现——**Chrome SW 走 `@fund01/services`+`@fund01/core`（JS），Tauri 走 `apps/tauri/src-tauri/src/`（Rust）**——必须保持逻辑 **1:1**：

1. **改动必须两端同步**：行情 / 计算 / 缓存 / 兜底逻辑的任何改动，必须在 JS 与 Rust 两端同时落地（标注「1:1 迁移」），**禁止只在某一端修改**。改一处忘另一处 = 未完成。
2. **「跨刷新保留旧值」类逻辑逐条对齐**：如 `mergeStaleEstimate`（自算失败兜底），其同源判断、QDII 跳过、confirmed 旧值不合并等所有条件必须逐字段对齐，差一条即分叉。
3. **公式层 1:1**：`calc_holdings`↔`calcHoldings`、`resolve_nav_pair`↔`resolveNavPair`、`is_confirmed_session_active` 等输入输出与边界处理必须一致，不得各自「优化」。
4. **新增数据源 / 兜底分支先对账**：先确认两端 provider 与计算层都覆盖，再做回归验证。
5. **验证门槛（PR / 发布前必做）**：同一持仓 + 同一数据源，两端各自手动刷新后 `totalPnl` 必须相等；不一致 → 阻断发布、回滚定位。

**已知历史坑（勿再犯）**：`mergeStaleEstimate` 曾只在 Chrome SW 实现，Tauri Rust 缺这段兜底 → 自算偶发失败时 Tauri 把 pnl 永久置 0、Chrome 用旧缓存救回 → 两端当日收益差。修复见 `apps/tauri/src-tauri/src/refresh.rs`（`merge_stale_estimate` + `last_quote_source` 同源判断），与 `ARCHITECTURE.md §4.1` 互参。

## 三个 Port 接口

定义在 `packages/core/src/port.ts`：

### DataPort（异步数据访问）

UI 首次打开主动拉一次缓存，避免等事件：

```typescript
export interface DataPort {
  triggerRefresh(): Promise<void>
  fetchHoldings(): Promise<HoldingsPayload>
  fetchIndices(): Promise<IndexItem[]>
  fetchFundHistory(code: string, count?: number): Promise<FundHistoryPayload>
  fetchIndexHistory(code: string, range: string): Promise<IndexHistoryPayload>
  fetchFundIntraday(fundKey: string): Promise<IntradayPoint[]>
  resolveFund(code: string): Promise<ResolveFundPayload>
}
```

### ConfigPort（同步读 + 异步推）

```typescript
export interface ConfigPort {
  getConfig(): AppConfig                  // 同步读本地缓存，UI 不闪
  saveConfig(config: AppConfig): Promise<void>  // 写本地 + 异步推后端
  onChanged(cb: (config: AppConfig) => void): () => void
}
```

设计理由：localStorage 同步读避免 UI 闪烁；Tauri 端可用内存镜像 + invoke 实现同样的「同步读 + 异步推」语义。

### EventPort（后端 → 前端事件）

```typescript
export interface EventPort {
  onQuoteUpdate(cb: (payload: QuoteUpdate) => void): () => void
  onConfigChange(cb: (config: AppConfig) => void): () => void
}
```

设计理由：统一 Chrome `chrome.storage.onChanged` 与 Tauri `listen` 两种事件机制，UI 不感知运行时差异。

### Port 实现

- `apps/chrome/src/ports/chromeDataPort.ts` — 通过 `chrome.runtime.sendMessage` 调 SW，缓存读 `chrome.storage.local`
- `apps/chrome/src/ports/chromeConfigPort.ts` — 同步读 `localStorage`，写时同时落 `localStorage`（同步读源）和 `chrome.storage.local`（key=`session-config`，SW 监听 `onChanged` 自动重排 alarm）
- `apps/chrome/src/ports/chromeEventPort.ts` — `onQuoteUpdate` 监听 `chrome.storage.onChanged` 的 `cache-time`；`onConfigChange` 监听 `window.addEventListener('storage', ...)`（跨窗口同步）
- `apps/tauri/src/ports/*`（未来）— 基于 `@tauri-apps/api` 的 `invoke` / `listen`

### 不抽象的部分

- **HttpClient**：fetch 跨 JS 运行时通用；Rust 后端用 reqwest 独立实现，不参与 TS 抽象
- **CSRF 缓存**：services 内部用模块级 Map，SW 重启时丢失（多请求一次 fund123.cn，可接受）
- **badge / 图标更新**：Chrome `setBadgeText` 与 Tauri 动态图标机制差异大，各 app 自行实现

## 数据源迁移指南

数据源请求要点（从 wzk-fund server 端迁移而来）：

### fund123.cn（蚂蚁基金，非天天基金）

- CSRF token 从 `https://www.fund123.cn/fund` 页面正则提取（`/"csrf":"([^"]+)"/`）
- 服务层用模块级 `Map` 缓存（TTL 10 分钟），SW 重启时丢失
- 扩展有 `host_permissions` 时 fetch 默认带 cookie；如遇 403 加 `credentials: 'include'`
- POST 请求需带 `X-API-Key: foobar`、`Origin`、`Referer` 头

### 东方财富 fundmobapi / push2

- 移动端 API，需设 `MOBILE_UA`
- 基金批量接口 `FundMNFInfo` 一次最多 200 个
- 指数 / 黄金走 `push2delay.eastmoney.com`（主），`push2.eastmoney.com` / `82.push2.eastmoney.com` 备用
- 公共参数 `ut=fa5fd1943c7b386f172d6893dbbd4dc`

### 腾讯 / 新浪

- 指数 K 线主源腾讯 `web.ifzq.gtimg.cn`，备用新浪 `money.finance.sina.com.cn`
- 美股指数备用新浪 US `stock.finance.sina.com.cn`
- 新浪黄金 `hq.sinajs.cn` 返回 GBK 编码，用 `TextDecoder('gbk')` 原生解码，**不要**引入 iconv-lite

### 小倍养基（api.xiaobeiyangji.com，非官方源）

- 单只 POST `https://api.xiaobeiyangji.com/yangji-api/api/get-fund-detail-v310`，body `{"code":"6位补零","version":"3.8.7.0","clientType":"APP"}`，需移动 UA
- 响应 `data.dailyYield`：number 小数盘中实时估值（0.0268 → 2.68%），**QDII 也有值**；`data.nav` 当前净值；`data.isQDII` 字段不可信（008987 实测 false 但 Fund01 按 QDII 处理），一律用 `is_qdii_name` 判定
- 能力边界：只有估值百分比 + nav，**无**估值净值/分时/历史净值 → 净值对与净值日期由东财 `FundMNHisNetList` 补齐
- ⚠️ 只取 dailyYield，**不用 changeRate 兜底**：changeRate 属热搜口径（开盘常为空），与 dailyYield 不同源，混用显示错误涨幅
- 缓存 60s TTL（Rust `XIAOBEI_CACHE` / TS `xiaobeiDetailCache`），并发 chunk=10；仅缓存有估值的响应
- 参考：wzk-fund 文档 `docs/小倍养基实时估值逻辑.md`

## 估值兜底规则（数据源 fallback 体系）

> **约定（必须遵守）**：本仓库所有「估值/净值的兜底、近似、fallback」行为以此章节为唯一权威。**新增或修改任何兜底规则时，必须同步更新：① 本章节；② 设置界面文案 `packages/ui/src/OptionsApp.tsx` 数据源选项下方的「估值兜底规则」说明**（保证用户可在设置中知晓）。遗漏任一处视为未完成。

> **预估 vs 实际净值**：盘中/盘后显示的「当日涨跌幅/收益」均为**估算值**，不同数据源的预估计算方式不同（FundMNFInfo 无 GSZ 时用重仓股加权自算、fund123 用官方分时估值），同一基金在两个数据源下的估算可能不同，**实际当日收益以官方披露净值为准**（一般当日 20:00 后开始更新）。

> **单向兜底约束（防循环）**：兜底方向**严格单向**——FundMNFInfo 源最多对单只基金发起**一次** fund123 fallback（内部只调 fund123 的 searchFund / queryFundEstimateIntraday，**不得**再回调 FundMNFInfo 或递归 fallback）；fund123 数据源（`get_fund_quote` / `getFundQuote`）**不得**触发 FundMNFInfo 兜底。同一基金最多走一次兜底，**严禁 A 源 fallback B 源、B 源又 fallback A 源的来回调用**。新增任何 fallback 前先核对本章节调用链。

### 数据源 = FundMNFInfo（默认 `quoteSource=fundmnfinfo`）

1. **FundMNFInfo**（移动 UA）盘中/空窗期均不返回 GSZ/GSZZL/GZTIME → 无官方盘中估值。
2. **自算估值** `get_calc_gszzl`（Tauri `fundmnfinfo.rs` / Chrome `fund.ts`）：用 FundMNInverstPosition 重仓股当日涨跌幅加权（缓存 5 分钟）。
3. **自算失败**（无股票重仓）时的 fallback 分流（fundmnfinfo.rs `fetch_one` / fund.ts `fetchOne`）：
   - **非 QDII 基金**（黄金/商品 ETF 联接等）：fallback fund123 官方分时估值（`fund123_estimate_fallback` / `fund123EstimateFallback`，取 queryFundEstimateIntraday 末点，校验 finite + |growth|<30 + net>0；fund_key 缺失时 searchFund 补查一次）。
   - **QDII 基金**（识别函数 `is_qdii_name` / `isQdiiName` 或 `FTYPE` 含 QDII/海外）：盘中无分时估值（fund123 实测 0 点、无重仓股无法自算）→ **当日收益显示「-」（灰色）**；**按「披露日」对齐普通基金口径**：QDII 披露日 = PDATE 的下一交易日（T+1），把披露日当作普通基金的「净值日」处理 —— `!is_trading_day_started(next_trading_day(披露日))` 才算「今日已更新」→ 才显示当日收益（`NAV`+`NAVCHGRT`，收益额 = 份额×(NAV−前一日NAV)−费用）。即：**净值披露后保留到披露日的下一交易日开盘前（如 08-06 净值 08-07 披露 → 08-07 ~ 08-10 开盘前持续显示，周末照常）**；开盘后恢复盘中口径，未更新时段保持 `-`——盘中任何时刻都不把未更新的滞后涨幅累计到「当日」标签下（天天基金全天挂旧净值会让 6 只 QDII 的当日收益互相抵消成误导性数字）。净值日期恒标注在基金列次行（如「净值08-05」）以便知晓滞后性。**盘中任何时候都跳过 fund123 兜底**（其对 QDII 无分时估值、`matiaria.dayOfGrowth` 是 T+1 昨日涨幅冒充今日）。**「已更新」徽标与当日收益同窗口**：QDII 的 `percentSource='confirmed'` 时 `shouldShowConfirmedUpdatedBadge`（TS）/`should_show_confirmed_updated_badge`（Rust）走 `isQdii` 分支（锚点 = 披露日 = PDATE 下一交易日，再按普通基金规则保留到披露日的下一交易日 09:15 前）——周末照常显示，下一交易日开盘后自动清除（与普通基金一致）。
4. **QDII 披露日窗口**：`has_replace` 用 `is_confirmed_session_active(pdate, now, delayed=is_qdii)`——QDII 走 delayed 分支（锚点 = 披露日 = PDATE 下一交易日，再判断披露日的下一交易日未开盘），境内走标准窗口（PDATE 下一交易日 09:15 前）。QDII 净值披露后（如 08-06 净值 08-07 披露）→ 周末/披露日下一交易日开盘前均 `confirmed` → 显示；开盘后（如 08-10 09:15 后）→ 保持 `-`。盘后填真实 prev 经 `FundMNHisNetList`（P0-2，禁止用涨幅反推）。

### 数据源 = fund123（`quoteSource=fund123`，`get_fund_quote` / `getFundQuote`）

- 逐只拉取 fund123（searchFund + matiaria + 分时走势 + 东财历史净值），**不触发 FundMNFInfo 兜底**。
- **QDII 口径**：盘中 percent 不显示（显示「-」，灰色），**按「披露日」对齐普通基金口径**（披露日 = PDATE 下一交易日，T+1；`is_confirmed_session_active` delayed 分支：净值披露后保留到披露日的下一交易日开盘前，周末照常显示「已更新」与当日收益）；不认 fund123 `matiaria.dayOfGrowth`（T+1 昨日涨幅冒充今日）与东财 hist 滞后日涨幅。净值日期恒标注在基金列次行。

### 数据源 = 小倍养基（`quoteSource=xiaobei`，`XiaobeiQuoteProvider` / `xiaobei.rs`）

- **盘中**：percent = 小倍 `dailyYield`×100（percentSource='estimate'），**QDII 与非 QDII 统一显示**（QDII 不再一直是「-」）。
- **盘后/确认窗口**：走 `resolveDisplayPercent`（TS）/fund123.rs 同构判定（Rust）——`isConfirmedSessionActive` 确认窗口命中时切到东财 `FundMNHisNetList` 已披露涨幅（percentSource='confirmed'）。
- **净值对**：net_value/prev_net_value/net_value_date 由东财 `FundMNHisNetList` 补齐；盘中 estimateNetValue = 最新确认净值×(1+估值涨幅)，当日收益 = 份额×净值×涨幅。
- **降级（per-fund）**：小倍失败/无估值 → 该基金回落 FundMNFInfo（其内部含自算/fund123 兜底）。单向 DAG：`xiaobei→fundmnfinfo→fund123`，无环，不违背上文单向兜底约束。
- **QDII「已更新」badge**：盘中无 confirmed 信号不显示；盘后东财对齐后照常显示。
- 缓存 60s（Rust `XIAOBEI_CACHE` / TS `xiaobeiDetailCache`），手动刷新 `clearFundEstimateCaches` 会清小倍缓存。

### 其他净值口径兜底

- `resolve_nav_pair`（Tauri `calc.rs`）/ `resolveNavPair`（`holdingsCalc.ts`）：仅确认净值、无昨净值/估值时，用 NAV 兜底 currNav → 金额 = 份额 × NAV 可显示（QDII 延迟净值、黄金联接、新基金均适用）。

## Service Worker 定时刷新

`apps/chrome/src/background/index.ts` 的核心流程：

1. **两个动态 alarm**（日盘 / 夜盘）：`chrome.alarms.create` 用单次 `delayInMinutes`，每次触发后只重排自身，按窗口判定（日盘 `isDayMarketActive` 09:00–15:30 / 夜盘 `isNightMarketActive` 20:00–次日 04:00）自动切换 trading / nonTrading 间隔
2. **配置驱动**：SW 通过 `chrome.storage.onChanged` 监听 `session-config` 变化（前端 `ConfigPort.saveConfig` 写入），自动按新间隔重排两个 alarm
3. **市场时段过滤**：用 `shouldRefreshFund` / `shouldRefreshAShareMarket` / `isGoldDaySession` / `shouldRefreshUSIndex` / `isGoldNightSession` 跳过非交易时段的数据源（保留旧缓存，避免无谓请求）；日盘 alarm 只刷基金 + A 股指数（含黄金 AU9999 / COMEX 黄金指数入口），夜盘 alarm 只刷美股指数（NDX/SPX）；指数看板无美股指数则不拉美股（夜盘 alarm 退化为低频空转）
4. **并发拉取**：`Promise.allSettled` 并发拉取基金 / 指数 / 大盘 / 黄金，任一失败不影响其他
5. **后端合并计算**（关键）：SW 调 `@fund01/core` 的 `calcHoldings` 把行情与配置合并成 UI 可直接渲染的 payload，结果写 `chrome.storage.local` 的 `cache-*` keys
6. **badge 更新**：合并完成后用 `chrome.action.setBadgeText` 显示持仓总收益率（如 `↑0.8%` / `-1.2%`），颜色红涨绿跌
7. **消息分发**：`chrome.runtime.onMessage` 处理 `REFRESH` / `FETCH_FUND_HISTORY` / `FETCH_INDEX_HISTORY` / `FETCH_FUND_INTRADAY` / `RESOLVE_FUND` 等同步类请求（DataPort 转发到此）

## Tauri 端规划（占位）

详见 `apps/tauri/README.md`。本次未实现 Rust 代码，仅文档说明未来路径：

- Rust 后端常驻，用 `tokio::time::interval` 定时刷新（不像 MV3 SW 30s 休眠）
- 通过 `app.emit` 推送事件到前端，前端用 `@tauri-apps/api/event` 的 `listen` 订阅
- menubar 模式：`TrayIconBuilder` + `WebviewWindow`（`decorations: false`、`skip_taskbar: true`、`always_on_top: true`）
- 配置存储用 Tauri store plugin 或文件
- 托盘徽章需动态生成图标 PNG（macOS 也支持 `tray.set_title` 显示文本）
- 实现路径决策（Rust 重写 services vs JS sidecar）延后到真正动手时再选

## 实际实现中的发现（重要）

以下是在 Task 1-11 实施过程中发现的、与原 plan 预期不完全一致的点，文档需如实记录：

### 1. `packages/ui/src/lib/fundOps.ts` 的存在

原 plan 设想组件直接调 `usePorts().config.saveConfig(...)` 修改配置。实际迁移时发现原 `lib/api.ts` + `lib/portfolioStore.ts` 中存在大量组合操作（`createFund` / `updateFund` / `removeFund` / `addHoldingGroup` / `renameHoldingGroup` / `setFundAllocation` / `updateSettings` / `importConfig` 等），这些函数封装了「金额反推份额」「成本反推」「分组维护」「归一化」等业务规则。

为避免在每个组件中重复展开这些逻辑，新增了 `packages/ui/src/lib/fundOps.ts`，把这些组合操作迁移为以 `Ports` 为参数的纯函数（不直接依赖 chrome.*），既保留原有业务规则，又通过 Ports 保持运行时解耦。组件中改为：

```tsx
import { createFund, removeFund } from '../lib/fundOps'
const { data, config } = usePorts()
await createFund({ data, config }, { code: '025687', amount: 1000, amountBasis: 'prev', group: '默认' })
```

`fundOps.ts` 不导出 Port 接口，仅是 UI 层的便利封装；Tauri 端可同样复用。

### 2. rsbuild 必须显式配置 `resolve.alias`

tsconfig 的 `paths` 字段只对 TypeScript 类型检查生效，**rsbuild 打包时不读 tsconfig paths**。因此 `apps/chrome/rsbuild.config.ts` 必须显式配置：

```typescript
resolve: {
  alias: {
    '@fund01/core': path.resolve(__dirname, '../../packages/core/src'),
    '@fund01/services': path.resolve(__dirname, '../../packages/services/src'),
    '@fund01/ui': path.resolve(__dirname, '../../packages/ui/src'),
  },
},
```

否则 build 时报 `Module not found: Can't resolve '@fund01/core'`。

### 3. tsconfig.json 不要设 `rootDir` / `outDir`

`apps/chrome/tsconfig.json`、`packages/services/tsconfig.json`、`packages/ui/tsconfig.json` 都**不设** `rootDir` 和 `outDir`。原因：

- 这些包都通过 `noEmit: true`（继承自 `tsconfig.base.json`）只做类型检查，不emit
- 设 `rootDir` 会触发 TS6059（"File is not under rootDir"），因为 `paths` 引用的源文件在包目录之外
- 仅 `packages/core/tsconfig.json` 保留了 `rootDir: ./src` + `outDir: ./dist`（无 paths 引用，不会触发 TS6059，保留以备未来单独构建）

### 4. `env.d.ts` 需声明 `*.css` 模块

`apps/chrome/src/env.d.ts` 和 `packages/ui/src/env.d.ts` 都需要：

```typescript
declare module '*.css';
```

否则 `import './index.css'` 在 strict 模式下报错。`apps/chrome/src/env.d.ts` 还需 `/// <reference types="chrome" />` 和 `/// <reference types="node" />`。

### 5. `output.distPath.js` 必须为空字符串

`apps/chrome/rsbuild.config.ts` 的 `output.distPath` 中 `js: ''`（不是默认的 `static/js`），确保 `background.js` 和 `popup.js` 直接产出在 `dist/` 根目录，匹配 `manifest.json` 中 `"service_worker": "background.js"` 的路径要求。MV3 SW 不允许 chunk 分割，配合 `chunkSplit: { strategy: 'all-in-one' }` 与 `filename: { js: '[name].js' }` 保证单文件输出。

### 6. SW 端配置读取改 `chrome.storage.local`

原 plan 设想 SW 读 `chrome.storage.session`。实际实现中，`ChromeConfigPort.saveConfig` 直接写 `chrome.storage.local`（key=`session-config`），SW 的 `getSessionConfig()` 也从 `chrome.storage.local` 读。`chrome.storage.session` 在 popup 关闭后仍可访问，但跨 SW 重启行为不如 local 稳定，统一用 local 更简单。

## 样式系统：tw-shim 手写垫片（重要）

本项目**没有 Tailwind 引擎**。原子类（`px-3` / `pb-3` / `flex` / `space-y-2` / `bg-paper-deep/50` 等）来自手写白名单 `packages/ui/src/tw-shim.css`，置于 `@layer utilities`（优先级高于 `radix-themes` 层）。Radix Themes 只提供组件与 CSS 变量（`--gray-*` / `--accent-*` / `--app-rise/-fall/-gold`），**不提供原子类**。

**铁律（新增/修改 JSX 类名前必读）**：
- tw-shim.css 里的类都是**人工维护的白名单**，缺哪个类就**静默失败**——类名照样挂到 DOM，但生成不出 CSS 规则，devtools 计算样式里查不到该规则，表现是「写了类名却没生效」，且**不报任何错**。
- 在 JSX 里写任何 Tailwind 风格原子类之前，**先 grep `tw-shim.css` 确认它存在**；不存在就**先在 tw-shim.css 补上对应规则**，再在 JSX 使用。
- 新增规则对齐既有写法：间距用 4px 刻度（`p-2`=8px、`p-3`=12px、`p-4`=16px）；颜色透明度用 `color-mix(in oklab, var(--xxx) NN%, transparent)`；任意值要转义（`h-[52px]` → `.h-\[52px\]{height:52px}`）。
- 改完类名后**必须跑守卫**：`pnpm --filter @fund01/ui guard:shim`（等价于 `node packages/ui/scripts/guard-shim.mjs`）。它扫描 `packages/ui/src` 所有 `className=` / `cn(...)` 字面量类名并逐个比对白名单，**缺类即 exit 1**；`.github/workflows/ci.yml` 在 push/PR 也会跑它，缺失类的提交会被 CI 拦下。

> 不要把 tw-shim 当「Tailwind」用：没有 JIT、没有 content 扫描、没有 safelist。它是固定白名单，靠人和守卫共同维护。

## Pitfalls

- **MV3 SW 生命周期**：空闲约 30 秒休眠，所有模块级状态（含 CSRF 缓存 Map）丢失。alarm 唤醒后重新获取可接受；不要依赖 SW 内存做持久状态
- **CSRF 内存 Map**：`services/fund.ts` 用模块级 Map 缓存 token，SW 重启时丢失，会多请求一次 `fund123.cn/fund` 抓 HTML。如需跨重启保留，可改用 `chrome.storage.session`，但当前实现选择「丢失可接受」
- **CSP 限制**：MV3 不允许 `eval()`、内联脚本，所有库（含 echarts）必须通过打包引入，不能用 CDN script 标签
- **localStorage 跨窗口**：每个 popup 实例独立 localStorage，跨窗口同步需用 `window.addEventListener('storage', ...)`（`ChromeEventPort.onConfigChange` 已处理）。同窗口修改不触发 storage 事件，靠 `ChromeConfigPort.saveConfig` 手动通知本地监听器
- **pnpm workspaces**：修改 packages 源码后无需 rebuild，rsbuild 直接打包源码；`pnpm install` 后 symlink 自动建立
- **rsbuild alias**：见上文「实际实现中的发现」第 2 条，必须显式配置
- **TypeScript strict**：所有 undefined 值用 nullish coalescing（`??`）或显式 null 检查处理；`noEmit: true` 全局开启
- **fetch 与 cookie**：扩展有 `host_permissions` 时 fetch 默认带 cookie，遇到 403 再尝试 `credentials: 'include'`
- **GBK 解码**：仅新浪黄金接口需要，用 `TextDecoder('gbk')` 原生解码，不引入 iconv-lite
- **chrome.alarms 最小间隔**：浏览器强制最小 0.5 分钟（30 秒），低于此值会被截断。`scheduleNextAlarm` 中 `Math.max(0.5, delaySec / 60)` 已处理
- **Popup 关闭即销毁**：Popup 关闭后 DOM 和 JS 全部销毁，不能依赖 popup 做后台轮询。所有定时逻辑必须在 Service Worker + chrome.alarms 中
- **popup 模式 vs dashboard 标签页**：原 wzk-fund 是 dashboard 标签页（全屏浏览器窗口），CSS 用 min-height: 100vh 是为标签页设计。重构为 popup 模式后，100vh = popup 视口高度但视口本身未定义 → 内容为 0 高度。修复：popup/index.html 内联 <style> 用 !important 强制固定尺寸（666x600）。详见 ARCHITECTURE.md §9.7
