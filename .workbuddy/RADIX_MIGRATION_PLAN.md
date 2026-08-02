# 交接文档：移除 shadcn/ui，全量迁移到 Radix Themes

> 生成时间：2026-08-02
> 起始状态：分支 `refactor/popup-ui`，`apps/chrome` 版本 `1.0.47`
> **新会话请先完整读完本文件，再开始动手。**

---

## 0. 背景：我们现在处于什么状态

项目此前用的是「自建 shadcn 风格组件」——即 Radix **Primitives**（无样式行为层）+ `cva` + `clsx` + `tailwind-merge` 手工拼装，配合 Tailwind v4 的 `@theme` 自定义色板（`--color-ink` / `--color-paper` / `--color-panel` 等）。

上一轮已经完成了**第一阶段迁移**：安装 `@radix-ui/themes@3.3.0`，用 **adapter 模式**把 `packages/ui/src/components/ui/*` 的内部实现换成了 Radix Themes 组件，但**保留了原有的导出名和 props 签名**，因此 15 个消费文件几乎没改。

本次任务是**第二阶段：拆掉 adapter 这层壳，让消费文件直接使用 Radix Themes 原生组件与设计令牌，并彻底移除 shadcn 遗留**。

### 上一阶段已解决的三个坑（勿重复踩）

1. **CSS 层级**：Radix Themes 不用 Tailwind（纯手写 CSS + `.rt-*` 类名，PostCSS 构建）。它输出的是**未分层**样式，而 CSS 规范规定未分层优先级高于任何 `@layer`，导致 3948 条 `.rt-*` 天然压过 Tailwind 工具类。
   已在 `packages/ui/src/index.css` 顶部修复：
   ```css
   @layer theme, base, radix-themes, components, utilities;
   @import 'tailwindcss';
   @import '@radix-ui/themes/styles.css' layer(radix-themes);
   ```
   层序刻意让 Radix 夹在中间：胜过 Tailwind preflight，但输给 Tailwind utilities。**不要改动这个顺序。**

2. **暗色模式**：官方 dark-mode 文档明确写「Do not set `<Theme appearance={resolvedTheme}>`, rely just on class switching」。现已改为 `applyTheme()` 同时写 `data-theme` 和 `classList.toggle('dark'/'light')`，并由 `apps/chrome/src/popup/index.tsx` 在 `createRoot().render()` **之前**同步调用 `initTheme()`（避免暗色首帧白闪）。`<Theme>` 不传 `appearance`。**不要退回传 appearance 的写法。**

3. **popup 高度链**：Radix 根主题自带 `.radix-themes:where([data-is-root-theme='true']) { min-height: 100vh }`，会撑破 popup 的 600px。已在 `index.css` 用 `.radix-themes { height: 100%; min-height: 0 }` 覆盖。**删掉会导致列表不滚动 + footer 消失。**

### 当前 `<Theme>` 配置（用户指定，勿擅改）

```tsx
<Theme accentColor="blue" grayColor="gray" radius="small">
```

---

## 1. 现状盘点（已实测，可直接采信）

### 1.1 `packages/ui/src/components/ui/` 现存 10 个文件

| 文件 | 内部实现 | 被引用文件数 | 处置 |
|---|---|---|---|
| `button.tsx` | 已是 Radix `Button` 适配器 | **11** | 替换调用点后删除 |
| `dialog.tsx` | 已是 Radix `Dialog` 适配器 | **9** | 替换调用点后删除 |
| `input.tsx` | 已是 Radix `TextField.Root` 适配器 | **5** | 替换调用点后删除 |
| `label.tsx` | 原生 `<label>` + Tailwind | **4** | 替换为 Radix `Text as="label"` 后删除 |
| `panel.tsx` | 已是 Radix `Card` 适配器 | **3** | 替换为 Radix `Card` 后删除 |
| `dropdown-menu.tsx` | 已是 Radix `DropdownMenu` 适配器 | **1** | 替换调用点后删除 |
| `skeleton.tsx` | **纯 Tailwind，未迁移** | **2** | 换成 Radix `Skeleton` 后删除 |
| `switch.tsx` | Radix 适配器 | **0** | **死代码，直接删** |
| `card.tsx` | Radix 适配器 | **0** | **死代码，直接删** |
| `badge.tsx` | Radix 适配器 | **0** | **死代码，直接删** |

> 目标：迁移完成后整个 `components/ui/` 目录**清空并删除**。

### 1.2 可以直接卸载的依赖（源码零引用，已实测）

`packages/ui/package.json` 中这 10 个 primitive 包**在全仓 `.ts/.tsx/.js` 中一次都没被 import**（它们只是 `@radix-ui/themes` 的传递依赖，pnpm 会自动处理）：

```
@radix-ui/react-dialog        @radix-ui/react-dropdown-menu
@radix-ui/react-label         @radix-ui/react-scroll-area
@radix-ui/react-select        @radix-ui/react-separator
@radix-ui/react-slot          @radix-ui/react-switch
@radix-ui/react-tabs          @radix-ui/react-tooltip
```

`class-variance-authority` —— **全仓零引用**，一并卸载。

> ⚠️ **`clsx` 和 `tailwind-merge` 暂时不能删**：它们被 `packages/core/src/utils.ts` 用来实现 `cn()`，而 `cn()` 在 19 个文件里还在用。等阶段 4 决定 Tailwind 去留后再定。

### 1.3 需要改动的消费文件（15 个，共 4471 行）

按行数降序，建议**从小到大**迁移，先在小文件上跑通模式再啃大的：

```
 57  components/popup/FundActionsMenu.tsx   ← 建议第一个（只用 dropdown-menu + button）
 69  components/popup/IndexBar.tsx          ← 第二个（skeleton）
143  components/MarketModules.tsx
170  components/FundDetailDialog.tsx
186  components/WatchlistModule.tsx
226  App.tsx                                 ← 含 <Theme>，谨慎
233  components/GoldHoldingsRow.tsx
253  components/popup/FundList.tsx          ← 已用 Radix Table，主要改色板
272  components/IndexTrendDialog.tsx
334  components/SparkTrend.tsx              ← ECharts，颜色取 CSS 变量，注意
335  components/FundFormDialog.tsx
433  components/FundTrendDialog.tsx
437  components/ImportHoldingsDialog.tsx
444  components/BatchEditHoldingsDialog.tsx
542  components/ConfigDialog.tsx            ← 最大，最后做
```

### 1.4 Tailwind 自定义色板用量（阶段 3 的主战场）

```
 80  text-muted        24  text-ink          20  border-line/70
 18  text-rise         18  text-ink-soft     12  bg-panel
 11  border-line       11  bg-paper/40        6  bg-paper/50
  6  bg-paper-deep      5  text-fall          5  border-line/60
  5  border-line/50     5  bg-accent          4  border-accent/50
  4  border-accent      4  bg-rise/10         4  bg-paper/30
  3  text-gold          2  text-muted/80
```

**已知冲突**：`@theme` 里声明的 `--color-panel` 与 Radix 自带的 `--color-panel` **撞名**。因为 CSS 自定义属性是逐元素解析的，`.radix-themes` 是 `:root` 的后代，所以 `bg-panel`（12 处）实际取到的是 Radix 的半透明面板色，`bg-panel/85` 会二次叠加透明度。其余 10 个 token（ink / paper / line / accent / muted / rise / fall / gold …）Radix 未占用，安全。

Radix 实际占用的 `--color-*` 只有这 6 个：`background`、`surface`、`overlay`、`panel`、`panel-solid`、`panel-translucent`。

---

## 2. Radix Themes 组件全清单（v3.3.0，已实测存在）

```
accessible-icon alert-dialog aspect-ratio avatar badge blockquote box button callout card
checkbox checkbox-cards checkbox-group code container context-menu data-list dialog
dropdown-menu em flex grid heading hover-card icon-button inset kbd link popover portal
progress quote radio radio-cards radio-group reset scroll-area section segmented-control
select separator skeleton slider spinner strong switch tab-nav table tabs text text-area
text-field theme theme-panel tooltip visually-hidden
```

**布局组件齐全**（`Flex` / `Grid` / `Box` / `Container` / `Section`），这意味着阶段 4 有可能连布局类的 Tailwind 也一起去掉。

### 关键 API 陷阱（上一轮踩过，已验证）

| 组件 | 陷阱 |
|---|---|
| `TextField` | **只有 `Root` 和 `Slot`，没有 `Input`**。`TextField.Root` 本身就是 forwardRef 的 `<input>`，props 直接放 Root 上。 |
| `TextField.Root` | HTML 的 `color` / `size` / `defaultValue` 属性与 Radix 更窄的联合类型冲突，spread 时需 cast。 |
| `DropdownMenu.Trigger` | **内部已自动 `asChild`**，外部再传 `asChild` 会 TS 报错。 |
| `Dialog.Content` | **不会自动渲染关闭按钮**，需自己放 `<Dialog.Close>`（现有 `.rt-dialog-close` 样式可复用）。 |
| `Badge` | `color` 是字面量联合类型，映射表要用 `as const` 而非 `Record<K, string>`。 |
| `Label` | **不是顶层导出**。用 `<Text as="label">` 或原生 `<label>`。 |
| `Table.Cell` | 支持 `align` 和 `width` props。 |
| `Table.Root` | 自身无 `overflow`，不会自建滚动容器（sticky thead 依赖外层滚动容器）。 |

---

## 3. 分阶段执行计划

> 每阶段结束都要：`pnpm --filter @fund01/ui typecheck` → `pnpm --filter @fund01/chrome typecheck` → `pnpm --filter @fund01/chrome build`，全绿才进下一阶段。

### 阶段 0：清理起点（必做，5 分钟）

当前工作区有 **22 个文件未提交**（1486 插入 / 1172 删除），包含上一轮全部迁移成果。

```bash
git add -A && git commit -m "refactor(ui): migrate to @radix-ui/themes (phase 1, adapters)"
```

**必须先提交**，否则阶段 2 的大规模改写一旦出问题无法二分回滚。

### 阶段 1：删死代码 + 卸无用依赖（低风险）

1. 删除 `components/ui/{switch,card,badge}.tsx`（零引用）
2. 从 `packages/ui/package.json` 移除 10 个 `@radix-ui/react-*` + `class-variance-authority`
3. `pnpm install`
4. 构建验证

### 阶段 2：拆 adapter，调用点直连 Radix（主体工作）

按 §1.3 的顺序，逐文件把 `from '../ui/button'` 之类换成 `from '@radix-ui/themes'`，并修正 props 差异：

| 旧（shadcn 语义） | 新（Radix 原生） |
|---|---|
| `<Button variant="default">` | `<Button variant="solid">` |
| `<Button variant="secondary">` | `<Button variant="soft">` |
| `<Button variant="danger">` | `<Button color="red">` |
| `<Button size="sm/default/lg">` | `<Button size="1/2/3">` |
| `<Button size="icon">` | `<IconButton>` |
| `<Input>` | `<TextField.Root>` |
| `<Label>` | `<Text as="label" size="2">` |
| `<Panel>` | `<Card>` |
| `<Skeleton>` | `<Skeleton>`（Radix 原生，注意 props 不同） |

**每迁完一个文件就 typecheck 一次**，不要攒着。全部完成后删除 `components/ui/` 目录。

### 阶段 3：色板收敛（改动量最大，200+ 处）

把 Tailwind 自定义色类换成 Radix 语义色。推荐映射：

| 现有 Tailwind 类 | Radix 替代方案 |
|---|---|
| `text-ink` | `<Text>` 默认色 / `var(--gray-12)` |
| `text-ink-soft` | `<Text color="gray">` / `var(--gray-11)` |
| `text-muted` (80 处!) | `<Text color="gray" size="1">` / `var(--gray-10)` |
| `bg-paper` / `bg-paper-deep` | `var(--color-background)` / `var(--color-surface)` |
| `bg-panel` | `<Card>` 或 `var(--color-panel-solid)` |
| `border-line` | `var(--gray-a6)` |
| `bg-accent` / `border-accent` | `var(--accent-9)` / `<Button>` 自带 |
| `text-rise` / `text-fall` | **保留自定义**（涨红跌绿是业务语义，Radix 无对应） |
| `text-gold` | **保留自定义** |

> **必须保留**：`--app-rise` (#e5484d) / `--app-fall` (#46a758) / `--app-gold` (#d4a017)。这是中国股市涨红跌绿约定，不能用 Radix 的语义色替代。
>
> 顺便修掉 `--color-panel` 撞名问题——阶段 3 做完后 `bg-panel` 应该已经不存在了，冲突自然消失。

### 阶段 4：决定 Tailwind 的去留（需要和用户确认）

做完阶段 3 后，Tailwind 只剩布局类（`flex` / `gap-*` / `grid` / `min-h-0` / `truncate` …）。两条路：

- **A｜保留 Tailwind 做布局**：改动小，`cn()` 和 `clsx`/`tailwind-merge` 留着。推荐。
- **B｜彻底移除 Tailwind**：布局全换 Radix `<Flex>` / `<Grid>` / `<Box>`，可卸载 tailwind + clsx + tailwind-merge + 删 `cn()`。产物更小但改动面再翻一倍。

**这一步开工前先问用户**。

### 阶段 5：收尾

- `SparkTrend.tsx` / ECharts 系列：图表颜色是 JS 里读 CSS 变量的，确认变量名改动后同步更新
- 检查 `index.css` 里是否还有孤儿规则
- 评估 `popup.js` 体积（当前约 1.5MB，含 Radix 全量 CSS）
- 更新 `packages/ui/src/index.ts` 导出

---

## 4. 项目约定（务必遵守）

- **每次 build 后 `apps/chrome/package.json` 的 `version` +1**。这是唯一版本来源，`manifest.json` 由 `apps/chrome/scripts/copy-manifest.mjs` 在 build 时自动同步，**不要手改 manifest**。
- 构建命令：`pnpm --filter @fund01/chrome build`，产物在 `apps/chrome/dist/`
- 交付方式：`cd apps/chrome/dist && zip -r -X ../../../fund01-popup-dist.zip .`，然后 present_files
- 当前分支 `refactor/popup-ui`

---

## 5. 新会话开场白（直接复制给新会话）

```
继续 fund01 项目的 UI 迁移任务：移除 shadcn/ui 残留，全量迁移到 @radix-ui/themes。

请先读 .workbuddy/RADIX_MIGRATION_PLAN.md，里面有完整的现状盘点、
分阶段计划、API 陷阱和项目约定。

从「阶段 0：清理起点」开始执行。每个阶段做完 typecheck + build 验证后
再进下一阶段，阶段 4 开工前需要先问我。
```
