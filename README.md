# Fund01 · 住在 Mac 菜单栏里的基金盯盘工具

**每个持仓分组一根独立菜单栏，一眼看清今天赚了多少、亏了多少，不用开任何窗口。**

关掉窗口也在跑：交易时段每 60 秒刷新一次，红涨绿跌直接写在菜单栏上。把基金 App 的持仓截图丢给 AI，自动转成结构化持仓一键导入。数据全部存在本机，是个人向的小工具，不商业化。

---

## 📸 截图预览

| 菜单栏样式 | 菜单栏自定义样式 |
| --- | --- |
| ![菜单栏样式](screenshots/菜单栏样式.png) | ![菜单栏自定义样式](screenshots/菜单栏自定义样式.png) |

| AI Agent 批量导入 | 常用设置 |
| --- | --- |
| ![AI Agent 批量导入](screenshots/ai%20agent%20批量导入.png) | ![常用设置](screenshots/常用设置.png) |

| 暗色模式 | 亮色模式 |
| --- | --- |
| ![暗色模式](screenshots/暗色模式.png) | ![亮色模式](screenshots/亮色模式.png) |

---

## ✨ 功能特性

### 🧩 多菜单栏实例（核心卖点）

- **一个分组，一根菜单栏**：把持仓按你的逻辑拆成多个分组——人工智能、海外投资、黄金，甚至一人一个分组专门追踪某位大 V 的持仓。每个分组在 Mac 顶部菜单栏各占一根，互不干扰；还有一个「全部」汇总所有持仓。
- **想看哪根看哪根**：每一根菜单栏都能单独开关。在设置里取消勾选即可隐藏，需要时再打开；也可以直接把它拖出菜单栏临时收起，随时能唤回，不会被删掉。
- **一眼看懂今天赚没赚**：每根菜单栏显示两行——分组名，以及当日涨跌幅，红涨绿跌，扫一眼就知道这组今天是红还是绿。
- **排版随心**：可以把视觉重点放在「分组名」或「涨跌幅」上；每根菜单栏的文字颜色、字体、对齐方向（靠左 / 居中 / 靠右）都能自由设置，几根并排也一眼分清谁是谁。
- **记住你的摆位**：菜单栏的顺序和你拖好的位置，重启后照样保留，不用每次重排。

### 🔄 后台常驻 · 实时刷新

- **常驻后台刷新**：App 在后台持续运行，关掉浮窗行情照样实时更新，不依赖浏览器插件。
- **智能分档刷新**：交易时段 60 秒 / 非交易时段 600 秒（可配置）。
- **日盘 + 夜盘自动切换**：白天刷基金、A 股指数和黄金；夜里自动转去刷美股指数和黄金夜盘，按市场作息走。
- **菜单栏徽章（badge）**：持仓总收益率直接写在菜单栏上，红涨绿跌，一瞥即知。

### 🪟 浮窗（Popup）

- **680×600 无装饰浮窗**：点击菜单栏实例弹出，干净无边框，不挡视线。
- **失焦即收起**：点击别处自动隐藏；闲置可配置时长后销毁，不占资源。
- **双行展示**：持仓支持「日盈亏百分比」或「日盈亏金额」双行显示。

### 🗂 持仓分组管理

- **多分组**：持仓可归到多个分组（同一只基金按比例拆分到不同分组）。
- **分组排序**：拖动调整分组在菜单栏上的出现顺序。
- **三种编辑入口**：单只添加 / 编辑（金额 + 表单复用）、批量编辑（份额）、导入（见下）。

### 🤖 AI 截图导入（差异化卖点）

- **截图即持仓**：把天天基金 / 支付宝等 App 的持仓截图交给 AI，自动识别成严格 JSON 数组，直接导入 Fund01。
- **代码自动纠错**：AI 同时输出基金名称，导入时按名称交叉校验 6 位代码——代码错、名字对时自动纠正并提示；两者都对不上则该条判失败、不污染数据。
- **金额口径严谨**：自动判断「资产是否已含当日收益」（`amountBasis: today / prev`）并优先锚定净值日期，避免隔夜导入把份额整体错算一天的涨跌幅。
- **失败可定位**：导入结果逐条列出成功 / 失败，失败项给出明确原因（如「代码与名称对不上，请核对」），不静默丢弃。

### 📈 指数 / 市场面板

- **多指数勾选**：popup 与设置双界面均可独立勾选关注指数。
- **黄金三看板**：AU9999 / XAU / COMEX 黄金行情，一眼看懂金价是涨是跌。
- **自选指数条**：菜单栏 / 顶栏最多容纳 5 个自选指数，常驻可见。

### 🔒 数据准确性承诺（信任护城河）

- **数字准确可核对**：所有涨跌幅、收益额都与官方净值口径严格对齐，绝不拿滞后涨幅冒充当日收益；估值口径在设置里对你公开，不留黑箱。
- **QDII 披露日口径**：QDII 按「净值披露日」对齐普通基金，盘中显示「-」而非用滞后涨幅冒充当日收益，净值日期恒标注在次行。
- **兜底透明**：自算估值失败时按基金类型分流（非 QDII 回退官方分时估值，QDII 保持「-」），规则在设置页对用户公开。

### 🎨 主题与系统要求

- **主题**：深 / 浅 / 跟随系统三主题，默认跟随系统。
- **最低系统**（桌面版）：macOS 13.0 (Ventura) 及以上（Intel 与 Apple Silicon 均可）。
- **定位**：个人小工具，非商业化，数据本地存储。

---

## 📦 两种产品形态

同一份前端代码（`packages/ui`）通过 Port 接口适配多个运行时，目前提供两种形态：

- **Chrome 扩展**：popup 看板 + 工具栏角标，MV3 Service Worker 后台定时刷新。
- **macOS 桌面版（Tauri）**：菜单栏常驻应用（不占 Dock），每个持仓分组一个菜单栏实例，实时显示当日涨跌；点击实例弹出浮窗看板。

---

## 🚀 开发指南

### 环境要求

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22+ | 建议使用仓库锁定的 pnpm |
| pnpm | 9.15.0 | `packageManager` 已锁定，可用 `corepack enable` |
| Rust | 最新稳定版 | **仅 macOS 桌面版**需要（Tauri 后端） |
| Xcode Command Line Tools | — | **仅 macOS 桌面版**需要 |

> macOS 桌面版 UI 基于 Radix Themes 3.x，其 CSS 依赖 Safari 15.4+ 的 Cascade Layers / `:has()` 与 Safari 16.2+ 的 `color-mix()`，低于 macOS 13 的 WKWebView 无法渲染 → 界面白屏，因此安装器会校验系统版本。

### 仓库结构

```
fund01/
├── packages/
│   ├── core/       @fund01/core      纯业务逻辑 + 接口契约（DataPort / ConfigPort / EventPort / WindowPort）
│   ├── services/   @fund01/services  数据请求层（原生 fetch，零 Chrome 耦合）
│   └── ui/         @fund01/ui        React 组件（通过 PortsContext 接受 Port 实现）
├── apps/
│   ├── chrome/     Chrome 扩展（popup + background SW + Port 实现）
│   └── tauri/      macOS 菜单栏桌面应用（Rust 后端 + 同一套 packages/ui）
├── scripts/        构建 / 打包 / 版本校验脚本
└── docs/           设计 spec、导入提示词与诊断文档
```

### 安装依赖

```bash
pnpm install          # 安装全部 workspace 依赖
pnpm typecheck       # 全仓库类型检查（Chrome + Tauri 前端 TS）
```

### Chrome 扩展开发

```bash
pnpm dev:chrome       # 开发模式（rsbuild --watch）
pnpm build:chrome     # 构建到 apps/chrome/dist/
pnpm zip:chrome       # 打包为可上传 Chrome Web Store 的 zip
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/chrome/dist/`。

### macOS 桌面版开发（Tauri）

```bash
pnpm --filter @fund01/tauri dev       # rsbuild dev（devUrl http://localhost:1420）
pnpm --filter @fund01/tauri tauri dev     # 拉起桌面端（开发）
pnpm --filter @fund01/tauri build         # rsbuild build → apps/tauri/dist
pnpm --filter @fund01/tauri tauri build   # 打包 .app / .dmg（输出到 src-tauri/target/release/bundle/）
```

双架构打包（Intel + Apple Silicon 两个独立安装包）：`node scripts/build-tauri-all.mjs`（详见 `CLAUDE.md`「双架构发布产物」）。

桌面版关键实现：

- macOS menubar 常驻（`ActivationPolicy::Accessory`，不占 Dock），多实例 = 每持仓分组一个 `NSStatusItem`（双行：分组名 + 涨跌%，涨红跌绿着色），未分组持仓进兜底实例。
- 菜单栏插件：`tauri-plugin-multiline-menubar`（git 依赖固定 `tag = "v1.6.0"`），原生 `set_colors` 支持 hex 逐行着色。
- 后台刷新：`tokio` 双循环（日盘 A 股 / 夜盘美股），按交易日历分档间隔（交易 60s / 非交易 600s），刷新后 `emit('quote-update')` + 更新 menubar。
- 浮窗：680×600 无装饰窗口，失焦 hide + 闲置销毁，点击重建。
- 存储：`tauri-plugin-store`（config.json）+ Rust 内存镜像（`AppState`）。

### 架构简述

**Port 抽象（跨端复用核心）**：UI 与具体运行时（Chrome / Tauri）之间通过四个接口解耦——`DataPort`（异步数据访问）、`ConfigPort`（同步读 + 异步推）、`EventPort`（后端 → 前端事件）、`WindowPort`（窗口 / 导航操作）。接口定义在 `packages/core/src/port.ts`。Chrome 与 Tauri 各自提供 Port 实现，UI 层零改动复用同一份 `packages/ui`。

**后端权威架构**：合并计算（收益率、市值等）在后端（Chrome Service Worker / Tauri Rust）完成，UI 是被动视图。这样菜单栏在无 UI 时也能工作、多窗口复用同一份结果、badge 在 popup 关闭后仍持续更新。

**跨端 1:1 对齐（信任红线）**：Chrome（JS）与 Tauri（Rust）两套独立实现对同一持仓 + 同一数据源必须给出完全一致的当日收益 / 收益率 / 单只涨跌。任何行情 / 计算 / 缓存 / 兜底逻辑的改动必须在两端同步落地，禁止只改一端；发布前需验证两端 `totalPnl` 相等。详见 `ARCHITECTURE.md` §4.1。

### 技术栈

TypeScript 6 / React 19 / pnpm workspaces / Rsbuild 2 / Radix Themes 3 / echarts 6 / Chrome MV3 / Tauri 2（Rust）

---

## ⚠️ 已知限制

- **macOS 桌面版未签名 / 未公证**：当前为 ad-hoc 签名，首次打开会被 Gatekeeper 拦截（需 `xattr -rd com.apple.quarantine /Applications/Fund01.app` 绕过）。后续版本计划接入 Developer ID 签名 + 公证。
- **仅支持 macOS**：菜单栏形态依赖 macOS 多 `NSStatusItem` 插件，Windows / Linux 适配未做。
- **Chrome 扩展 popup 为 MV3 形态**：设置、持仓编辑等重操作放在原生 options 页（常驻标签页），popup 仅保留看板与快捷操作。

---

## 📚 文档

- [CLAUDE.md](./CLAUDE.md) — 开发指南（命令、架构、数据源、Pitfalls）
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计（Port 抽象、后端权威、Chrome vs Tauri 对照、跨端对齐铁律）
- [apps/tauri/README.md](./apps/tauri/README.md) — 桌面版实现说明（menubar / 刷新 / 事件 / 命令清单）

---

## 💖 致谢

本项目部分灵感与基金计算的逻辑沿用自以下两个开源项目，在此致谢：

- [x2rr/funds](https://github.com/x2rr/funds)
- [kid-kang/wzk-fund](https://github.com/kid-kang/wzk-fund)

---

## 👤 作者的其他项目

- [newtab01 · 由书签驱动的 Chrome 新标签页](https://chromewebstore.google.com/detail/newtab01-bookmark-driven/nlecfkdndodablijmfcjbnannkgmpegj) — 支持分组和分屏打开目录
- [No lazyload · 禁用图片懒加载](https://chromewebstore.google.com/detail/no-lazyload-disable-image/gdaoomgmekonglmdeaoengblkjeopall) — 强制网页立即加载所有图片
