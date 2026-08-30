# tauri-plugin-multiline-taskband 适配说明（Windows 任务栏形态）

> 状态：本分支（feat/windows-taskband）首次接入该插件，Windows 真机调试由维护者自行进行。
> 本文记录：① fund01 如何使用该插件；② 与 macOS `tauri-plugin-multiline-menubar` 的 API 对照；
> ③ 插件能力差距的**评估结论：全部不处理**（2026-08-30 决策存档，接受 macOS 与 Windows
> 的行为差异；不要为凑差异直接改插件源码）。

- 插件仓库：<https://github.com/lingyired/tauri-plugin-multiline-taskband>
- 本分支固定版本：`tag = v1.0.0`（2026-08-30 插件首个 stable tag。相对 2026-08-29 的
  rev 9597d41 仅 Windows 渲染修复——TrafficMonitor 风格整格背景带 + `DT_VCENTER` 垂直居中，
  字形顶部不再被裁切——与 demo 改动（per-line 系统默认色模式、控制台重构），
  **Rust/JS API 与命令均无变化**，宿主无需适配即升级）
- 插件定位：仅 Windows 运行时生效（非 Windows 目标全部返回 `UnsupportedPlatform`）；
  fund01 在 Cargo.toml 里将其放入 `[target.'cfg(target_os = "windows")'.dependencies]`，
  macOS 构建完全不编译该插件（macOS 的 `tauri-plugin-multiline-menubar` 同理反向隔离）。

## 一、fund01 的接入方式

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 依赖 | `apps/tauri/src-tauri/Cargo.toml` | windows target 段，git tag 固定 |
| 插件注册 | `src/lib.rs` | `.plugin(tauri_plugin_multiline_taskband::init())`（cfg windows） |
| 实例编排 | `src/taskband.rs`（cfg windows） | 与 macOS `menubar.rs` 平行的编排层 |
| 纯逻辑共享 | `src/menubar_common.rs` | 实例期望集合/涨跌口径/id 编解码，两平台共用 |
| 平台分派 | `src/status_bar.rs` | `rebuild` / `update_with` / `on_menu_event` 统一入口 |
| 托盘 | `src/tray.rs`（cfg windows） | Tauri 官方 tray-icon（插件不含托盘能力） |
| 浮窗定位 | `src/window.rs` `position_below` | 非 macOS 分支用插件 click rect（物理像素）定位 |

约定（与 macOS menubar 同款纪律，勿回退）：

- **create 一次终生不销毁**：显隐只走 `set_visible`；仅分组删除/重命名才 `remove`。
- 插件原生层把 `create`/`set_*` 派发到独立 UI 线程（异步入队）→ **不回读 `is_visible`/`rect`**，全部幂等声明式下发。
- 插件 `set_auto_popup(false)`：浮窗生命周期由 `window.rs` 自管（懒创建、失焦隐藏、闲置 5 分钟销毁），点击事件由应用监听 `multiline-taskband://{id}//click`（左键）后自行 `show_popup`。
- 实例 id 沿用 macOS 命名：`menubar-overview` / `menubar-group-{分组名hex}` / `menubar-ungrouped`；popup tab 映射（总览→'all' 等）复用 `menubar_common::popup_tab_for`。
- **排序**：`set_order` 每轮按 desired 顺序幂等下发（总览 0 → 分组按 holdingGroups 顺序 → 未分组最后）。同侧实例按 order 升序**从边缘向内**排布，右缘起点在通知区左侧 → 默认布局「总览」最靠右。
- **停靠侧**：`menubarGroupSides`（key 约定同 `menubarHiddenGroups`：`''`/`'__overview__'`/分组名，缺省=右侧）→ 每次 rebuild `set_side` 幂等下发。
- **外边距**：`menubarEdgeMargins` `{left,right}`（物理像素）→ `set_edge_margins`（全局 API）。
- 每次刷新路径（refresh → `status_bar::update_with`）与保存配置路径（save_config → `status_bar::rebuild`）都会全量幂等下发文本/颜色/样式/侧/序。

## 二、与 multiline-menubar 的 API 对照（v1.6.1 ↔ taskband v1.0.0）

### 等价（fund01 直接沿用同一配置字段）

| menubar（macOS） | taskband（Windows） | fund01 配置字段 |
| --- | --- | --- |
| `create(id)` | `create(id, side)` | — |
| `remove(id)` | `remove(id)` | — |
| `set_text(id, top, bottom)` | 同 | —（行情数值） |
| `set_font_sizes(id, top, bottom)`（pt） | 同 | `menubarTopFontSize` / `menubarBottomFontSize` |
| `set_font_family(id, top?, bottom?)`（None/""=系统字体） | 同 | `menubarTopFont` / `menubarBottomFont` |
| `set_bold(id, top, bottom)` | 同 | `menubarTopBold` / `menubarBottomBold` |
| `set_alignment(id, 0\|1\|2)` | 同 | `menubarTopAlign` / `menubarBottomAlign` |
| `set_colors(id, ColorStyle, ColorStyle)`（`Solid{value}`/`Default`） | 同 | `menubarTopColor` / `menubarGroupColors` / 涨跌平色 |
| `set_visible` / `is_visible` | 同 | `menubarHiddenGroups` |
| `set_popup_window(label)` / `set_auto_popup(bool)` | 同（全局） | 固定 `("menubar", false)` |
| `open_popup` / `close_popup` / `toggle_popup` | 同（本应用未用，auto_popup=false + 自管浮窗） | — |
| `set_menu(id, items)` | `set_menu(id, Option<items>)`（`None`=摘除；menubar 另有 `remove_menu`） | 固定「打开设置…/退出」 |
| 事件 `multiline-menubar://{id}//click`（`{button, rect…}`） | `multiline-taskband://{id}//click`（多 `id`/`position`/`buttonState` 字段，rect 为物理像素） | — |

### taskband 新增（macOS 无对应）

| API | fund01 用法 |
| --- | --- |
| `set_side(id, left/right)` | `menubarGroupSides`（每分组停靠侧，设置页「位置」列） |
| `set_order(id, u64)` | desired 顺序自动下发（无 UI，跟随持仓分组排序） |
| `set_edge_margins(left?, right?)`（全局，物理像素） | `menubarEdgeMargins`（设置页「任务栏边距」） |
| `set_padding(id, left, right)` / `set_margin(margin)` | 未暴露 UI（用插件默认 4px） |

### menubar 有、taskband 没有（fund01 已绕开，差异接受，见第三节决策存档）

| 缺失 API | fund01 的处理 |
| --- | --- |
| `set_layout(id, 0\|2)`（强调行/等大） | Windows 设置页**隐藏「布局模式」**；插件固定上下两行渲染，字号直接用布局 0 的上行/下行字段（Rust `apply_taskband_style` 不再读 `menubar_layout`/`menubar_equal_font_size`） |
| `set_tooltip` | 不下发（macOS 每实例 tooltip = "上行 下行"） |
| `//remove` 事件（macOS ⌘-拖出隐藏） | Windows 无拖出通道，隐藏分组走实例右键菜单「隐藏『分组名』」（写 `menubar_hidden_groups`，语义=设置页取消勾选，见 `taskband.rs::hide_group_from_menu`）或设置页开关；总览两入口均不可隐藏 |
| `quit` 保留 id（menubar v1.6.1 延迟退出） | **应用自理**：`taskband::on_menu_event` 收到 `…::quit` 后 `app.exit(0)` |

### 其他行为差异（编码时踩过/核对过的点）

1. **菜单项 id 带命名空间**：插件把菜单项建成 `{instance_id}::{action_id}`，其内部全局
   `on_menu_event` handler 解析后另发 `multiline-taskband://{id}//menu`。fund01 的全局
   handler 会收到**带前缀的原始 id**，因此 `taskband::on_menu_event` 用 `split_once("::")`
   剥前缀再匹配（托盘菜单是裸 id，两种形态都要兼容）。应用**不要**再监听 `//menu` 事件（会双路径重复处理）。
2. **MenuItemDescriptor 字段名**：taskband 的 `Item` 变体是 `enabled: Option<bool>`，
   menubar 是 `disabled: Option<bool>`，语义相反，拷贝菜单构造代码时必须改名。
3. **rect 坐标系**：click rect / `rect()` 均为**物理像素、top-left 原点**（macOS 版是 points、
   bottom-left 原点）；浮窗定位（`window.rs` 非 macOS 分支）按物理像素处理并 clamp 到目标显示器。
4. **权限**：插件 `default.toml` 不含 `set-popup-window`/`open-popup`/`close-popup`/`toggle-popup`/`remove`/`set-menu`。
   fund01 全部从 Rust 侧调用（不走 webview IPC），无需改 capabilities；若将来前端直调需补权限。
5. **托盘不在插件范围内**：Windows 托盘用 Tauri 官方 `tray-icon` feature（`tray.rs`），
   左键 Click → `show_popup(rect, "all")`（默认总览分组），右键弹原生菜单（复用全局菜单事件分发）。

## 三、插件能力差距评估：全部不处理（2026-08-30 决策存档）

以下差异点曾作为「希望插件后续提供」的清单逐项评估，结论是**全部忽略/不处理**——
macOS 与 Windows 本就是两种形态（菜单栏 vs 任务栏），行为存在合理差异，不再作为
升级插件的核对项。后续插件升级只跟进崩溃/安全问题，本节仅作决策存档防止重复评估。

1. ~~保留 `quit` 菜单 id 并延迟退出~~ —— **忽略**。Windows win32 菜单无 macOS
   trackMouse 收尾问题，宿主在 `taskband::on_menu_event` 里同步 `app.exit(0)` 即可，
   与 menubar v1.6.1 的延迟退出机制差异可接受。
2. ~~补 `set_tooltip(id, text)`~~ —— **暂不需要**。Windows 任务栏项无悬停提示，
   不影响使用。
3. ~~补 `//remove`（拖出隐藏）事件~~ —— **忽略**。macOS 菜单栏支持按住 ⌘ 拖出移除，
   Windows 任务栏本身不支持拖拽，无对等交互场景；Windows 隐藏分组走实例右键菜单
   「隐藏」项（2026-08-30 新增，语义与设置页取消勾选一致）或设置页开关。
4. ~~`set_edge_margins` 支持逻辑像素~~ —— **不处理**。配置字段与 UI 文案按物理像素
   语义固定，不再等待插件改逻辑像素。
5. ~~per-monitor DPI（WM_DPICHANGED）~~ —— **不处理**。多屏异 DPI 下文字/布局的
   偏差由插件层决定，宿主不做补偿。
6. ~~竖直任务栏布局打磨~~ —— **不处理**。浮窗定位已兼容竖直任务栏，分组排布维持现状。
7. ~~`default.toml` 权限范围~~ —— **不处理**。fund01 全部从 Rust 侧调用，不走
   webview IPC，权限不构成限制（若将来前端直调再补 `multiline-taskband:allow-*`）。
8. ~~Windows 10 未验证~~ —— **不处理**。插件仅验证过 Windows 11，fund01 不承诺 Win10。

## 四、Windows 版已知限制（真机调试关注点）

- ~~浅色主题任务栏下，上行文字默认白色（`menubarTopColor` 默认 `#ffffff`）对比度差~~
  **（v1.0.0 已解决，2026-08-30）**：上行颜色未自定义时改发 `ColorStyle::Default`
  （跟随系统任务栏文字色，深浅色模式自适应），解析链见 `taskband.rs top_color_style`：
  分组自定义色（menubarGroupColors）→ 全局上行色（menubarTopColor ≠ 默认白才算自定义）→
  `ColorStyle::Default`。macOS menubar 不走此链，仍恒回落白色（两平台上行色默认值自此分叉）。
- 任务栏自动隐藏、explorer 重启重布局、多屏异 DPI、竖直任务栏：插件层能力，未在 mac 侧验证。
- 浮窗（popup）680×600 逻辑尺寸、失焦隐藏、闲置 5 分钟销毁与 macOS 完全一致；
  Windows 上依赖 `Focused(false)`（无 macOS 的全局点击 monitor，理论上够用——
  Windows 点击浮窗外会正常转移焦点）。
- 「menubar 全空且无窗口 → 自动退出」逻辑仅 macOS 生效：Windows 有托盘常驻，app 不自动退出。
- 静默启动 / 开机自启动沿用 `tauri-plugin-autostart`（Windows 走注册表 Run 键），`--autostart`
  参数语义与 macOS 相同。

## 五、构建与调试命令（Windows 机器）

```powershell
# 前置：Node 22+ / pnpm 9.15 / Rust stable-msvc / WebView2（Win11 自带）
pnpm install
pnpm --filter @fund01/tauri tauri:build:windows   # tauri build --bundles nsis
# 产物：apps/tauri/src-tauri/target/release/bundle/nsis/*.exe
```

- `tauri.windows.conf.json`（bundle.targets=nsis）构建 Windows 时自动与主配置合并。
- `bundle.icon` 已含 `icons/icon.ico`（托盘/任务栏/安装器共用）。
- 日常调试：`pnpm --filter @fund01/tauri tauri:dev`（在 Windows 上运行）。
