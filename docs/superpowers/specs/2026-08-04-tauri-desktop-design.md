# fund01 Tauri 桌面版设计（2026-08-04）

> 状态：✅ 已批准并实现（阶段 1-6 完成，`apps/tauri/`）。本文档记录产品与技术决策。

## 背景

Chrome MV3 扩展已稳定。基于同一份 `packages/ui` + `packages/core`（types + 4 Port 契约）开发 Tauri 2 macOS 桌面版。monorepo 重构阶段已预留：`packages/core/src/port.ts` 的 `DataPort/ConfigPort/EventPort/WindowPort` 为 Tauri 实现定义契约，`apps/tauri/README.md` 有完整设计蓝本。

## 已拍板决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 数据层架构 | **路径 A：Rust 重写**（reqwest + serde），TS 只留 UI | menubar 常驻需要后端独立持有数据；单二进制；不引入 sidecar |
| 产品形态 | macOS **menubar 常驻**（`ActivationPolicy::Accessory` 不占 Dock） | 盯盘定位，贴合扩展角标/弹窗心智 |
| 菜单栏 | **多实例**：总览 + 每持仓分组一个 NSStatusItem，两行（上分组名/下涨跌%），**涨红跌绿**着色 | 直接看分组涨跌 |
| 菜单栏配色 | 复用自研插件 `tauri-plugin-multiline-menubar` 的 `set_colors`（1.0.0 已内置，hex 着色） | 零插件改动 |
| 浮窗尺寸 | 680×600（与 Chrome popup 同尺寸） | `packages/ui` 零改动 |
| 浮窗生命周期 | 失焦 hide → 闲置 5min 销毁（可配置）→ 点击重建 | 内存与秒开平衡 |
| 设置页 | 独立普通窗口 1200×800，`options.html?tab=` 复用 OptionsApp | 与 Chrome options 同构 |
| 版本号 | 独立（Cargo.toml 1.0.0） | 两端解耦发版 |
| 数据源 | fund123（CSRF+cookie）与 fundmnfinfo（桌面 UA 批量）**双全**，quoteSource 切换 | 双源保留 |
| 平台 | macOS only | 当前需求 |

## 架构与数据流

```
Rust 常驻进程（tokio 循环，按交易日历分档 60s/600s）
  → reqwest 拉取（fund123 / fundmnfinfo / push2 / 新浪 / 腾讯）
  → 合并计算（calcHoldings / mergeWatchlist，板块推断回写）
  → RwLock<QuoteUpdate> 缓存
  → app.emit('quote-update') + 更新 menubar 实例（文字+颜色）
WebView（浮窗/设置窗口）经前端 Port：
  → invoke 读缓存（fetch_holdings 等）/ 实时 RPC（history/intraday/resolve_fund）
  → listen 订阅 quote-update / config-change
配置：save_config → normalize → store 持久化 → emit config-change → rebuild_menubar → 立即刷新
```

## 目录结构（apps/tauri/）

```
src-tauri/src/
  lib.rs          装配（插件/命令/setup/菜单事件/初始刷新）
  commands.rs     14 个 #[tauri::command]（对应 4 Port）
  state.rs        AppState（quote/config 缓存 + popup 销毁计时器）
  refresh.rs      刷新循环 + refresh_all + patches 回写
  menubar.rs      多实例编排（总览 + 分组 + 未分组，≤6）+ 点击监听 + 菜单
  window.rs       浮窗生命周期（hide→5min→destroy）+ settings 窗口
  model.rs        serde 模型（types.ts 1:1）
  providers/      fundmnfinfo.rs（三态解析+自算估值）、fund123.rs（CSRF）
  market.rs/gold.rs/history.rs/theme.rs  行情与板块推断
  calc.rs/calendar.rs/portfolio.rs/fundname.rs/format.rs/badge.rs  计算层
src/
  menubar.tsx / options.tsx  入口（initTheme + ConfigPort.init + PortsContext）
  ports/tauri{Data,Config,Event,Window}Port.ts + lazyMemo.ts
```

## 关键实现要点

1. **Rust 侧直接调用 menubar 插件**（`MultilineMenubarExt`），无需前端参与；`set_auto_popup(false)` 生命周期自管
2. **tauri 2.11 API 变化**：`listen` 已从 `Emitter` 拆到 `Listener` trait；async command 含 `State` 引用时必须返回 `Result`
3. **fund123 CSRF**：`reqwest` 开 `cookie_store`（会话 cookie）+ 正则抓 `"csrf":"..."` + 403/401 强刷重试
4. **FundMNFInfo 三态口径**：hasReplace（NAV 确认）/ 盘中 GSZ / 空窗期（重仓股加权自算 `getCalcGszzl`，缓存 5min）
5. **GBK 解码**：新浪黄金 `encoding_rs::GBK`
6. **sectors 回写**：刷新后 persistPatches 合并进 config 并落盘广播（避免板块推断结果丢失）
7. **前端同步读**：`TauriConfigPort.init()` 启动拉一次到 LazyMemo，`getConfig()` 同步返回

## 验证

- `cargo check` / `cargo test`（format/fundname 单测）通过；`cargo build` 成功（含 native ObjC++）
- `pnpm typecheck` / `pnpm build`（rsbuild 双入口）通过
- `pnpm tauri build --debug --bundles app` 出 .app
- 运行时验证（需 GUI）：多实例显示/着色、浮窗开合/延迟销毁、双数据源出数、设置窗口 ?tab=

## 后续（未做）

- `POPUP_DESTROY_DELAY_SECS` 接入设置项；菜单栏实例数上限折叠交互
- Windows/Linux 适配；Developer ID 签名 + notarization 分发
- `tauri-plugin-multiline-menubar` 从 path 依赖切换 crates.io
