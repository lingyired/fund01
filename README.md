# fund01

基金 / 组合盯盘工具，支持 Chrome 扩展和未来 Tauri 桌面应用。同一份前端代码（`packages/ui`）通过 Port 接口适配多个运行时。

## 状态

- ✅ Chrome 扩展：可用（popup + badge 模式，MV3 Service Worker 后端定时刷新）
- 🚧 Tauri 桌面应用：占位，仅文档（`apps/tauri/README.md`）

## 快速开始

```bash
pnpm install          # 安装依赖
pnpm dev:chrome       # 开发模式（rsbuild --watch）
pnpm build:chrome     # 构建到 apps/chrome/dist/
pnpm zip:chrome       # 打包为可上传 Chrome Web Store 的 zip
pnpm typecheck        # 全仓库类型检查
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/chrome/dist/`。

## 目录结构

```
fund01/
├── packages/
│   ├── core/       @fund01/core      纯业务逻辑 + 接口契约（DataPort/ConfigPort/EventPort）
│   ├── services/   @fund01/services  数据请求层（原生 fetch，零 Chrome 耦合）
│   └── ui/         @fund01/ui        React 组件（通过 PortsContext 接受 Port 实现）
├── apps/
│   ├── chrome/     Chrome 扩展（popup + background SW + 3 个 Port 实现）
│   └── tauri/      Tauri 应用（占位，仅 README）
└── docs/superpowers/  设计 spec 与实施计划
```

## 文档

- [CLAUDE.md](./CLAUDE.md) — 开发指南（命令、架构、数据源、Pitfalls、实际实现发现）
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计（三个 Port、后端权威、Chrome vs Tauri 对照）
- [设计 spec](./docs/superpowers/specs/2026-07-30-monorepo-refactor-design.md)
- [实施计划](./docs/superpowers/plans/2026-07-30-monorepo-refactor.md)
- 各 package README：
  - [packages/core/README.md](./packages/core/README.md)
  - [packages/services/README.md](./packages/services/README.md)
  - [packages/ui/README.md](./packages/ui/README.md)
- [apps/tauri/README.md](./apps/tauri/README.md) — Tauri 未来实现路径

## 技术栈

TypeScript 6 / React 19 / pnpm workspaces / Rsbuild 2 / Tailwind v4 / Radix UI / echarts / chrome MV3 / @fund01/* workspace packages（源码直引，不预构建）

## 架构一句话

`packages/ui` 通过 `PortsContext` 接受 `DataPort` / `ConfigPort` / `EventPort` 三个接口的实现；`apps/chrome` 提供 Chrome 版实现（基于 `chrome.storage` / `chrome.runtime.sendMessage` / `chrome.alarms`），未来 `apps/tauri` 提供 Tauri 版实现（基于 `invoke` / `listen` / Rust 后端）。合并计算在后端（SW / Rust），UI 是被动视图。
