# Fund01 基金盯盘

基金实时估值、持仓收益、大盘指数一站式盯盘工具。同一份前端代码（`packages/ui`）通过 Port 接口适配多个运行时，目前提供两种形态：

- **Chrome 扩展**：popup 看板 + 工具栏角标，MV3 Service Worker 后台定时刷新
- **macOS 桌面版（Tauri）**：菜单栏常驻应用，每个持仓分组一个菜单栏实例，实时显示当日涨跌

## ✨ 功能特性

**看板（popup / 浮窗）**

- 持仓列表：实时估值、当日收益、持有收益、成本明细
- 持仓分组：自定义分组 + 分组汇总（当日收益额 / 收益率），支持拖拽排序
- 大盘指数看板：沪深、美股、港股、黄金、债券等指数实时行情，可自定义勾选与排序
- 走势图：基金历史净值曲线、指数历史走势、盘中分时（估值）走势
- 深色 / 亮色主题，跟随系统

**Chrome 扩展专属**

- 工具栏角标：显示收益率或收益额（k/w/kw 简写），红涨绿跌
- 后台定时刷新：交易时段 / 非交易时段使用不同间隔
- 一键导入持仓：粘贴 / 文件 / 让 AI 助手从持仓截图生成 JSON（内置提示词）

**macOS 桌面版专属**

- 菜单栏常驻（不占 Dock）：总览 + 每个持仓分组一个实例，上行分组名、下行当日涨跌%
- 点击菜单栏实例弹出浮窗看板，实时跟随

**数据与口径**

- 双数据源可切换：FundMNFInfo（天天基金，批量拉取更快，默认）/ fund123（蚂蚁基金）
- 盘中估值 + 官方确认净值双口径；估值缺失时用重仓股当日涨跌幅估算参考值兜底
- QDII 按「披露日」规则处理：只有官方披露最新净值才显示当日收益，未披露显示「-」，不拿旧数据顶替

**数据安全**

- 持仓与设置全部保存在本机（Chrome：`localStorage`；桌面版：本地 store 文件）
- 一键导出 / 导入配置备份，随时换设备迁移

## 🚀 快速开始（Chrome 扩展）

```bash
pnpm install          # 安装依赖
pnpm dev:chrome       # 开发模式（rsbuild --watch）
pnpm build:chrome     # 构建到 apps/chrome/dist/
pnpm zip:chrome       # 打包为可上传 Chrome Web Store 的 zip
pnpm typecheck        # 全仓库类型检查
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/chrome/dist/`。

## 🖥️ macOS 桌面版（Tauri）

```bash
cd apps/tauri
pnpm install
pnpm tauri dev        # 开发模式
pnpm tauri build      # 打包 .app / .dmg（输出到 src-tauri/target/release/bundle/）
```

## 📦 目录结构

```
fund01/
├── packages/
│   ├── core/       @fund01/core      纯业务逻辑 + 接口契约（DataPort / ConfigPort / EventPort / WindowPort）
│   ├── services/   @fund01/services  数据请求层（原生 fetch，零 Chrome 耦合）
│   └── ui/         @fund01/ui        React 组件（通过 PortsContext 接受 Port 实现）
├── apps/
│   ├── chrome/     Chrome 扩展（popup + background SW + Port 实现）
│   └── tauri/      macOS 菜单栏桌面应用（Rust 后端 + 同一套 packages/ui）
└── docs/           设计 spec、导入提示词与诊断文档
```

## 📚 文档

- [CLAUDE.md](./CLAUDE.md) — 开发指南（命令、架构、数据源、Pitfalls）
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计（Port 抽象、后端权威、Chrome vs Tauri 对照）
- [apps/tauri/README.md](./apps/tauri/README.md) — 桌面版实现说明

## 🧰 技术栈

TypeScript 6 / React 19 / pnpm workspaces / Rsbuild 2 / Tailwind v4 / Radix UI / echarts / Chrome MV3 / Tauri 2（Rust）

## 💖 致谢

本项目部分灵感与基金计算的逻辑沿用自以下两个开源项目，在此致谢：

- [x2rr/funds](https://github.com/x2rr/funds)
- [kid-kang/wzk-fund](https://github.com/kid-kang/wzk-fund)

## 👤 作者的其他项目

- [newtab01 · 由书签驱动的 Chrome 新标签页](https://chromewebstore.google.com/detail/newtab01-bookmark-driven/nlecfkdndodablijmfcjbnannkgmpegj) — 支持分组和分屏打开目录
- [No lazyload · 禁用图片懒加载](https://chromewebstore.google.com/detail/no-lazyload-disable-image/gdaoomgmekonglmdeaoengblkjeopall) — 强制网页立即加载所有图片
