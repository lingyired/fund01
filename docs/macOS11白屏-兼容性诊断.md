# macOS 11 白屏兼容性诊断报告

> 状态：**已定方案并落地（2026-08-18，commit 4075991，tauri v1.1.0）**：声明最低系统版本 macOS 13.0，macOS 11/12 由安装器直接拒绝，不再出现白屏。修复方案见 §5。
> **⚠️ 2026-08-19 更新（tauri v1.2.0，feat/macos-10.15-compat）**：§5 的「硬性勿降 13.0」结论已被**兼容层方案**取代——最低系统版本降至 macOS 10.15，旧系统通过运行时切换 compat.css 正常使用（视觉降级）。详见 §7。
> 触发场景：Fund01 桌面版（Tauri + Radix Themes 3.x）在 **macOS 11 (Big Sur)** 上运行时，popup 浮窗与设置界面均白屏。
> 诊断日期：2026-08-18（周一）

---

## 1. 现象

在 macOS 11 上安装并运行 Fund01：

- **popup 浮窗白屏**（无任何内容/样式）；
- **设置界面白屏**（同样）；
- app 进程能启动、菜单栏实例存在（原生层正常），说明 Rust/系统层 OK，问题出在 WebView 渲染层。

用户直觉猜测："是不是某个依赖兼容性有问题？" —— **对，是 CSS 依赖的兼容性问题，但不是 JS 也不是 Tauri 本身。**

---

## 2. 一句话根因

**UI 基于 `@radix-ui/themes` 3.3.0，其 CSS 大量使用 macOS 11 自带 WKWebView（WebKit = Safari 14.1）不支持的现代 CSS 特性：`@layer`（Cascade Layers）、`color-mix()`、`:has()`、`lab()`、`dvh`。Safari 14.1 遇到不认识的 `@layer` at-rule 会整块跳过，Radix Themes 与项目自身（tw-shim.css）的样式几乎全部包在 `@layer` 里 → 样式全丢 → 白屏。**

这不是 app 代码 bug，是**前端技术栈（Radix Themes 3.x）的最低浏览器要求已高于 macOS 11 的 WebView 能力**。硬结论：Radix Themes 3.x 的 CSS 需要 Safari 16.2+（= **macOS 13+**）；macOS 11/12 都会样式全丢。

---

## 3. 证据链（逐项排查）

### 3.1 排除法：哪些依赖没问题

| 依赖 | 官方最低要求 | macOS 11 是否满足 | 结论 |
|---|---|---|---|
| **Tauri 2** | macOS 10.15+ | ✓ | 不是 Tauri 的问题 |
| **React 19** | Safari 13.1+ (ES2020) | ✓ | 不是 React 的问题 |
| **产物 JS 语法** | — | ✓ | 见 3.2 |

### 3.2 产物 JS 侧扫描（安全）

对 `apps/tauri/dist/index.js` / `options.js` 做语法特征扫描：

| 语法/API | 产物中数量 | Safari 14.1 支持 | 结论 |
|---|---|---|---|
| `?.`（可选链） | 239 | ✓ (13.1+) | OK |
| `#private`（class 私有字段） | 38 | ✓ (14+) | OK |
| `String.replaceAll` | 3 | ✓ (13.1+) | OK |
| `??=` / `||=` | 0 | ✓ (14+) | OK |
| `Array.prototype.at` / `findLast` | 0 | — | 未使用 |
| `structuredClone` / `withResolvers` | 0 | — | 未使用 |

JS 侧语法安全，白屏**不是 JS 崩溃**导致。

### 3.3 产物 CSS 侧扫描（命中根因）

`static/css/index*.css`（714KB，popup 与设置共用）：

| CSS 特性 | 产物中数量 | 需要的最低 WebKit | macOS 11 (Safari 14.1) |
|---|---|---|---|
| `@layer`（Cascade Layers） | 6 处 | Safari 15.4+ | ❌ **整块被跳过** |
| `color-mix()` | **110 处** | Safari 16.2+ (macOS 13+) | ❌ |
| `:has()` | **77 处** | Safari 15.4+ | ❌ |
| `lab()` | 2 处 | Safari 15.4+ | ❌ |
| `dvh` | 4 处 | Safari 15.4+ | ❌ |

产物中 `@layer` 的完整形态（`grep -oE '@layer[^;{]*'`）：

```
@layer theme
@layer base{
@layer radix-themes{
@layer components
@layer utilities{   ×2
```

- **Radix Themes 3.x 的全部样式都包在 `@layer radix-themes{...}` 里**；
- 项目自身 tw-shim.css 的 utilities 全在 `@layer utilities{...}` 里；
- Safari 14.1 不认识 `@layer` at-rule → **解析时跳过整个块** → 所有 Radix 组件样式 + 工具类全部丢失 → 白屏。

---

## 4. 影响范围与设备覆盖

### 4.1 会白屏的系统

- **macOS 11 (Big Sur)**：Safari 14.1 → 白屏
- **macOS 12 (Monterey)**：Safari 15.x，`@layer`/`:has()`/`dvh` 已支持但 **`color-mix()` 仍不支持**（需 Safari 16.2+，即 macOS 13+）→ 颜色体系失效，实际也白屏
- **macOS 13 (Ventura) 及以上**：Safari 16.2+ → 全特性支持，正常

### 4.2 macOS 13 支持的设备（官方列表，来源 support.apple.com/kb/HT213264）

| 产品线 | 支持的最老年份 |
|---|---|
| MacBook Pro | **2017** 年起 |
| iMac / iMac Pro | **2017** 年起 |
| MacBook | 2017 年（Retina 12 英寸） |
| MacBook Air | **2018** 年起 |
| Mac mini | **2018** 年起 |
| Mac Pro | 2019 年起 |
| Mac Studio | 2022 年起 |

即：**macOS 13+ 覆盖 2017 年之后的全部 Mac（含最后一波 Intel + 所有 Apple Silicon）**。声明最低 macOS 13+ 放弃的仅是 2015–2016 的 MacBook Pro、2014–2017 的 MacBook Air、2014 Mac mini、2015 iMac、2013 圆柱 Mac Pro——这些设备停在 macOS 10.15/11/12，正好就是白屏的那批。

---

## 5. 解决方案（已选方案 A 并落地）

### 5.1 决策

三个候选：

| 方案 | 内容 | 结论 |
|---|---|---|
| **A. 声明最低 macOS 13+** | `bundle.macOS.minimumSystemVersion = "13.0"` | ✅ **已选**，零成本，与 Radix Themes 3.x 技术要求对齐 |
| B. 构建期降级 CSS | postcss-cascade-layers 展开 `@layer` + polyfill `color-mix` | ❌ 工作量大，且 Radix 3 深度依赖 `@layer` 级联语义，展开后易样式错乱 |
| C. 运行时 WebView 检测 | 启动时检测版本并提示 | ❌ 不如安装器直接拒绝干净 |

### 5.2 落地内容（commit 4075991）

1. **`apps/tauri/src-tauri/tauri.conf.json`**：
   ```json
   "bundle": {
     ...
     "macOS": {
       "minimumSystemVersion": "13.0"
     }
   }
   ```
   字段经 `@tauri-apps/cli@2.11.4` 的 `config.schema.json` 验证为官方字段（`MacConfig.minimumSystemVersion`）→ 打包时写入产物 Info.plist 的 **`LSMinimumSystemVersion`**。效果：macOS 11/12 双击 app 时系统直接提示「需要 macOS 13 或更高版本」，**从"装完才知道坏"变成"装之前就拦下"**。

2. **产物验证**（`plutil -p`）：
   ```
   arm64  : "LSMinimumSystemVersion" => "13.0"  ✓
   x86_64 : "LSMinimumSystemVersion" => "13.0"  ✓
   ```

3. **文档同步**：
   - `README.md` 桌面版章节：加「系统要求：macOS 13.0 (Ventura) 及以上」+ 白屏原因简述；
   - `CLAUDE.md`「双架构发布产物」：标注「最低系统版本（硬性，勿降）」，防止误降。

### 5.3 硬性约定（勿降）

> **最低系统版本 macOS 13.0 是硬性约束**，与 Radix Themes 3.x 的 CSS 能力绑定。未来若需支持 macOS 12 及以下，唯一出路是整体更换 UI 技术栈（不用 Radix Themes 3），而不是在构建期做 CSS 降级 hack。

---

---

## 6. 相关链接

- 官方兼容列表：https://support.apple.com/kb/HT213264
- macOS Ventura 系统要求（Wikipedia）：https://en.wikipedia.org/wiki/MacOS_Ventura
- 关联 commit：`2e14cd0`（双架构发布）、`4075991`（最低系统版本）、`fff2e4d`（merge 入 main）

## 7. 兼容层方案（2026-08-19，取代 §5 的「硬性勿降」结论）

> 决策：最低系统版本 **macOS 10.15**。兼容 CSS 按 Safari 13.1 构建，天然覆盖 10.15/11/12；macOS 13+（Safari 16.2+）走完整样式，零影响。原则：**能跑起来优先，不介意旧系统视觉降级**（渐变/半透明/`:has`/hover 等效果 fallback 或丢失）。

### 7.1 机制（双 CSS + 运行时检测）

1. **构建期**：`tauri.conf.json` 的 `beforeBuildCommand` 在 `pnpm build` 后执行 `node ../../scripts/build-compat.mjs`：
   - 读取 `dist/static/css/*.css`（主 CSS），产出 `index-<hash>.compat.css`；
   - 变换 pass（顺序固定）：prepend 规范层序声明 → `:where()`/`:is()` 递归笛卡尔展开（postcss-selector-parser，AST 级）→ `:focus-visible`→`:focus` → `color-mix()` 降级（一方为 `transparent` 取另一方、否则取第一参数，`var()` 保留引用）→ `@supports` 条件内 `color-mix` 改写为 `red` → `dvh`→`vh`（含 `@supports` 条件）→ `@csstools/postcss-cascade-layers` 展开 `@layer`；
   - 改写 `dist/index.html` / `options.html`：注入内联脚本，`CSS.supports('background','color-mix(in srgb, red, blue)')` 为 false 时把主 CSS link 置 `media="not all"` 并追加 compat.css link；
   - 用 esbuild 把 `dist/index.js` / `options.js` 整包转译到 safari13 目标（回写原文件）：Rsbuild 的 swc 规则默认排除 node_modules，`@radix-ui/react-collection` 等依赖 dist 的 class 私有字段/static block（Safari 13.1 解析不了会整包挂）必须构建后转译。
2. **运行期**：macOS 13+（Safari 16.2+）检测通过 → 完整样式；macOS 10.15–12 → 自动切 compat.css。
3. **Rust/部署**：`minimumSystemVersion = "10.15"` 经 tauri-build 传播为 `MACOSX_DEPLOYMENT_TARGET`（已实证作用于全部 C/.mm/Rust 依赖）；menubar 插件 v1.6.1 的 13+ API 已有 `@available` 守卫，10.15 编译无碍。
4. **JS**：`apps/tauri/rsbuild.config.ts` 的 `tools.swc.env.targets = ['safari >= 13.1']` 只降 JS 转译（class 私有字段等），刻意不用 `overrideBrowserslist`（避免 lightningcss 连带污染主 CSS）。运行时 API 扫描无缺口（bundle 中 `this.at()` 为 OrderedDict 自定义方法，非 `Array.prototype.at`）。

### 7.2 预期降级（10.15–12，可接受）

| 特性 | 旧系统表现 |
|---|---|
| `color-mix()` 半透明（110 处） | 降级为实色（`var()` 引用保留） |
| `:has()`（77 处） | 整条规则被解析器丢弃（hover/联动样式丢失） |
| `:where()`/`:is()`（2821 处） | 展开为普通选择器，特异性与原意近似（`csstools` 用 `:not(#\#)` 链补偿层优先级） |
| `:focus-visible` | 降级为 `:focus` |
| `dvh` | 降级为 `vh` |
| flex `gap`（233 处，仅 10.15 的 Safari 13.1 不支持） | 间距坍缩（10.15 特有；macOS 11+ 正常） |
| `lab()`（2 处） | 已有 hex 兜底声明在前，自动回退 |
| 渐变/毛玻璃 | `linear-gradient`/`-webkit-backdrop-filter` Safari 13.1 均支持，不受影响 |

### 7.3 验证（2026-08-19，构建级）

- compat.css：`@layer`/`color-mix(`/`:where(`/`:is(`/`dvh`/`:focus-visible` 残留均为 0；
- 层优先级：`.bg-app`（utilities）`:not(#\#)` 链 8 条 > `.rt-Button`（radix-themes）4 条 → 工具类正确覆盖组件样式（兼容产物同时修正了 §7.4 的层序问题）；
- JS 产物无 class 私有字段等 ES2022+ 残留（`node --check` 语法通过；esbuild 目标 es2020——safari13/14 目标因 esbuild 无法降级解构而不可用）；
- 产物 Info.plist `LSMinimumSystemVersion` = `10.15`；
- 二进制 minos（vtool）：**x86_64 = 10.15**（Intel 版可在 Catalina 运行）✓；**aarch64 = 11.0**——rustc 对 Apple Silicon 的最低支持版本即 11.0（Big Sur 本就是第一款 AS macOS，硬件无法安装更低系统，无实际影响）；
- 前端资源以压缩形式内嵌二进制（资源名表可见 compat.css 条目）；
- 真机验证（macOS 11 VM / 10.15 Intel Mac）由用户安排。

### 7.4 遗留问题（另开任务，不在本分支处理）

- **全量 CSS 层序 bug**：minifier 把 `@layer` 声明顺序打乱为 utilities 最前（= 优先级最低），理论上 macOS 13+ 上 tw-shim 工具类对 Radix 组件的覆盖也受影响（需实机确认）。兼容产物已通过 prepend 规范层序修正，全量 CSS 待单独排查。

### 7.5 相关改动文件

- 新增 `scripts/build-compat.mjs`；改 `apps/tauri/rsbuild.config.ts`、`apps/tauri/src-tauri/tauri.conf.json`（min 10.15 + beforeBuildCommand + v1.2.0）、`Cargo.toml`/`Cargo.lock`（v1.2.0）、根 `package.json`（devDeps：postcss、@csstools/postcss-cascade-layers、postcss-selector-parser、esbuild）、README.md、本文件。
