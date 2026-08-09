# 编辑持仓页 Spec（聚焦文档，补充于总 spec 之后）

> 本文档是 `持仓录入展示统一-spec.md` 的**补充**，只聚焦「设置页 → 编辑持仓」这一个页面。
> 总 spec 已定稿（未改动）；其中 §1.1 把编辑页的「现状」写成「持有份额 + 成本单价」，而**实际代码已改为「持有金额 + 持有收益」**，以本文档为准。
> 状态：该页已按本文档口径实现（代码现状即 as-built）；§6.1 的「金额口径选择器」已于 2026-08-08 补齐（v1.2.41）。

---

## 1. 核心结论

编辑持仓页的表格，**可编辑列 = 持有金额 + 持有收益**；**持有份额 / 成本单价 / 持有成本 为只读派生展示，不可手填**；表格上方提供**金额口径选择器（今日结算 / 昨日结算）**，决定持有金额按哪一版净值折算份额。

这响应了总 spec 的 D2（统一录入 = 持有金额 + 持有收益）与 D3（显示持有成本），并落实了用户补充要求：「编辑表格加只读的持有份额/成本单价展示，不允许编辑」。

---

## 2. 表格列定义（实际实现）

| 列 | 可编辑？ | 数据来源 | 说明 |
|---|---|---|---|
| 基金（名称 + 代码） | 否 | `EditRow.name/code` | 只读 |
| **持有金额** | ✅ 编辑 | `EditRow.amount` | = 当前市值；输入框 placeholder「当前市值」 |
| **持有收益** | ✅ 编辑 | `EditRow.holdProfit` | = 当前市值 − 成本本金；留空表示保留原成本单价 |
| 持有份额 | 只读 | `deriveRowReadonly` 派生 | = 持有金额 ÷ 最新净值 |
| 成本单价 | 只读 | `deriveRowReadonly` 派生 | = (持有金额 − 持有收益) ÷ 持有份额 |
| 持有成本 | 只读 | `deriveRowReadonly` 派生 | = 持有金额 − 持有收益（精确） |
| 分组 | ✅ 编辑 | `EditRow.group` | 下拉切换/合并 |
| 删 | 操作 | — | 移除该分组份额 |

表头与单元格位置（`OptionsApp.tsx`）：表头 `:1290-1294`；持有金额输入框 `:1318-1329`；持有收益输入框 `:1330-1339`；只读单元格 `:1341-1368`。

表格上方另有**金额口径选择器**（SegmentedControl，`prev`=昨日结算 / `today`=今日结算）：
- `prev`：持有金额按「上一交易日确认净值」折算份额；
- `today`：持有金额按「今日确认净值」折算份额（要求数据源已出今日净值，否则折算/保存报错并提示改用 prev）；
- 默认值：navMeta 就绪后按「数据源是否已出今日净值」智能推断（有今日净值 → today，否则 prev），与单只弹层编辑模式的推断一致；用户手动切换后不再自动覆盖。

---

## 3. 数据流

### 3.1 加载（`loadEditRows`，`batchEdit.ts`）
- 按分组展开每只基金的 `allocations[g]`（份额）与 `costs[g]`（成本单价）→ 生成 `EditRow`。
- `amount` / `holdProfit` 初始留空，`initialized=false`（待净值回填）。

### 3.2 净值回填（`OptionsApp` 的 `navMeta` effect）
- 拉取每只基金 `resolveFund` 完整结果（`navMeta[code]`，含今/昨净值与日期）。
- 口径（`basis`）就绪 + 净值就绪后，为未初始化行预填：
  - `持有金额 = 份额 × 口径基准净值`（`pickBasisNav(basis, meta).nav`）
  - `持有收益 = 持有金额 − 份额 × 成本单价`（成本为 0 时留空）
- 用 `initialized` 标记防重载覆盖；切换口径时未手动编辑（`touched`）的行重置重新预填，保证「不改即保存份额不变」；用户已编辑的行保留。
- 当前口径取不到基准净值（如 today 但数据源尚无今日净值）→ 该行保持未预填（金额空），切换口径后自动重试。

### 3.3 实时派生（`deriveRowReadonly`，`batchEdit.ts:33-52`）
- 输入 `amount` + `holdProfit` + `nav` → 输出：
  - `shares = round(amount / nav, 4)`
  - `costPrice = (amount − holdProfit) / shares`（>0 才给，否则 null）
  - `holdingCost = amount − holdProfit`
- **nav 缺失或金额≤0 → 三项均 null**，UI 显示原值兜底（`r.shares`/`r.cost`）或「—」。

### 3.4 保存（`handleSave`，`OptionsApp.tsx:1114-1189`）
逐行写入目标分组的 `allocations`/`costs`：
```
nav   = pickBasisNav(basis, navMeta[code]).nav     // 口径基准净值（口径不可用时抛错提示）
shares = round(amount / nav, 4)
cost   = 持有收益已填 → round((amount − holdProfit) / shares, 6)
         持有收益留空 → 保留原成本单价（不误清空）
```
原 config 中存在但行集合不再覆盖的分组 → 清零（避免移动/删除后残留）。

---

## 4. 关键代码文件与函数

| 文件 | 位置 | 职责 |
|---|---|---|
| `packages/ui/src/OptionsApp.tsx` | `EditHoldingsSection` `:952-1430`（含金额口径选择器 `:1269-1283`） | 表格渲染、列头、输入框、只读单元格、口径选择器、保存逻辑 |
| `packages/ui/src/lib/batchEdit.ts` | `EditRow` 类型 `:13-30`、`deriveRowReadonly` `:35-54`、`loadEditRows` `:57-113` | 行模型、只读派生、行加载 |
| `packages/ui/src/lib/fundOps.ts` | `setFundAllocation` / `pickBasisNav` / `resolveFund`(netValue) | 落库、口径净值解析 |

存储模型不变：`allocations[group]=shares` + `costs[group]=costPrice`，与全 app 一致。

---

## 5. 与总 spec 的关系

- 落实总 spec **D2**（统一录入 = 持有金额 + 持有收益）与 **D3**（显示持有成本）。
- 落实用户补充：「编辑表格加只读的持有份额/成本单价，不允许编辑」。
- 成本单价在此页**降为派生值**，不再手填（与总 spec「成本单价降为派生」一致）。
- 行内「分组」切换/合并逻辑保留：合并时持有金额与持有收益相加，成本单价自动派生（`:1050-1092`）。

---

## 6. 已知差异 / 后续可补（非阻塞）

1. **金额口径选择器（amountBasis）**：✅ **已补齐（2026-08-08，v1.2.41）**。表格上方提供「今日结算 / 昨日结算」全局口径选择器，预填与保存折算均经 `pickBasisNav(basis, meta)`，与单只弹层完全对齐；默认按「数据源是否已出今日净值」智能推断。
2. **净值缺失兜底**：nav 取不到时只读三列显示原值/「—」，保存会报错提示「缺少持有金额或确认净值」——符合预期，不阻塞。
3. **持有收益留空语义**：留空 = 保留原成本单价（不清空），与导入模块 `holdProfit` 缺失时保留 `cost` 的行为一致。
