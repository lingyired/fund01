# QDII 净值/当日收益失效 —— 根因分析与改造方案（定稿）

> **本文档为分析 + 可执行方案，QDII 计算逻辑本次不产生代码改动，待确认后实施。**
> （注：「数据说明」Tab 已于本会话先行落地实现，详见 §十；其内 QDII 相关文案按目标方案撰写，实际行为待 §一~§七 实施后对齐。）
> 日期：2026-08-07　参考项目：`/Users/lingsmbp/Documents/github/wzk-fund`（commit `8a86e1b` “feat: 持仓分境内/QDII 并新增 Q&A 说明页”，2026-08-03）
> 状态：**方案已与用户逐轮确认定稿，待实施。**

---

## 一、结论先行（最终决策）

用户现象「QDII 两个数据源都不好使，晚上净值也不计算」**不是数据源缺数据，而是我们自己的三道判定闸门把已经拿到的官方数据丢掉了**。

实测证明（2026-08-07 多次实跑东财接口）：

- `FundMNFInfo` **确实返回** QDII 的 `NAV` + `PDATE` + `NAVCHGRT`（官方已披露净值与涨跌幅）；
- `FundMNHisNetList` **确实返回** QDII 完整的相邻净值序列（可直接算真实收益）。

数据一直都在，是代码没用。wzk-fund 在 `8a86e1b` 做的本质就是**承认 QDII 属于「延迟披露」品种，改用官方历史净值序列结算，并放弃对它套用 A 股的盘中/确认时间窗**。这套思路高度值得参考，且我们仓库已有 80% 基础设施（`fetch_fund_nav_history` 已存在并在 fund123 链路使用），改造成本低。

### 已确认的最终展示规则（QDII）

| 场景 | 当日收益列 | 最新净值列 | 基金列次行 |
|---|---|---|---|
| **盘中**（A 股 09:30–15:00 交易日） | `-`（**灰色**） | 净值数字（如 2.6338） | `净值08-05`（灰小字，仅 QDII） |
| **盘后**（官方净值披露后，约 20:00 起） | `+0.90%` / `+169.02` | 净值数字 | `净值08-05`（灰小字，仅 QDII） |

要点：

1. **盘中一律 `-` 灰色**：QDII 无重仓股（无法自算）、fund123 无分时估值（实测 0 点），盘中确实拿不到「今日」数字，不造数。
2. **盘后显示最新已披露净值日的收益**：即 `NAVCHGRT` + 收益额 `份额×(NAV−前一日NAV)−费用`。因 QDII 延迟披露（T+1/T+2），该数字对应滞后净值日（如 08-05），**与天天基金/支付宝口径一致**。用户只关心数字本身（已用 005698 截图核对，天天基金把 08-05 净值变动展示为「昨日收益 +169.02」）。
3. **净值日期放「基金列次行」**（方案 B），**不放净值列**——避免挤占「最新净值」列宽、影响整张表。仅 QDII 显示该日期，非 QDII 不显示（避免拥挤）。
4. **不引入「陈旧阈值自动隐藏」**：用户心智是「只关心数字」，日期已显式标注在名下，足以解释滞后，故不做 wzk 那种有界放行（详见 §四 B'）。
5. **分组当日收益额聚合排除 QDII（盘中）**：见 §六。

---

## 二、根因定位（含实测证据）

### 2.1 实测数据

`FundMNFInfo`（`plat=Android&appType=ttjj&product=EFund&Version=1`，桌面 UA）：

| 代码 | 名称 | NAV | PDATE | NAVCHGRT | GSZ | GSZZL | GZTIME |
|---|---|---|---|---|---|---|---|
| 016532 | 嘉实纳斯达克100ETF发起联接(QDII)A | 2.1749 | 2026-08-05 | -0.78 | **null** | **null** | **null** |
| 005698 | 华夏全球科技先锋混合(QDII)A | 2.6338 | 2026-08-05 | 0.90 | null | null | null |
| 040046 | 华安纳斯达克100ETF联接(QDII)A | 8.2320 | 2026-08-05 | -0.86 | null | null | null |
| 100050 | 富国全球债券(QDII)人民币A | 1.2667 | 2026-08-05 | -0.02 | null | null | null |
| 008987 | 广发上海金ETF联接C（非 QDII） | 1.9407 | 2026-08-06 | 1.95 | null | null | null |
| 161725 | 招商中证白酒(LOF)A（非 QDII） | 0.5606 | 2026-08-06 | -0.50 | null | null | null |

`FundMNHisNetList`（016532）：

```
2026-08-05  DWJZ=2.1749  JZZZL=-0.78
2026-08-04  DWJZ=2.1920  JZZZL= 3.19
2026-08-03  DWJZ=2.1243  JZZZL= 1.69
```

两个关键事实：

1. **`GZTIME` 已对全部场外基金停止返回**（QDII 与非 QDII 一样），但 `PDATE`/`NAVCHGRT` 正常。
2. **QDII 的 `PDATE` 落后一档**（08-05，即 T+2）；境内基金是 08-06（T+1）。这就是「延迟披露」的客观表现——00-05 不是丢数据，是还没披露。

### 2.2 三重闸门

#### 闸门 1：`hasReplace` 强依赖 `GZTIME` → `confirmed` 永远为 false（主因）

`apps/tauri/src-tauri/src/providers/fundmnfinfo.rs:115`
`packages/services/src/fund.ts:1144-1146`

```rust
let has_replace = pdate != "--" && !pdate.is_empty()
    && !gztime_day.is_empty()          // ← GZTIME 现在恒为 null
    && pdate == gztime_day;
```

`GZTIME` 恒 null → `gztime_day` 恒空 → **`has_replace` 恒 false** → 落入 else 分支（`fundmnfinfo.rs:146-150`）：只记 `net_value`，`day_growth = None`、`prev_net_value = None`、`confirmed = false`。

> **影响范围超出 QDII**：在 FundMNFInfo 数据源下，`confirmed` 分支**对所有基金都是死代码**。境内基金靠「自算估值」兜底成功，表面看不出问题；QDII 无重仓股、自算必然失败，就彻底裸奔了。
> 这也意味着 `CLAUDE.md:164` 原写的「晚间官方净值披露后 confirmed 分支自动显示当日涨跌幅」**从未真正生效过**，文档与实现已脱节（本次同步修正）。

#### 闸门 2：A 股确认会话窗对 QDII 天然不成立

`apps/tauri/src-tauri/src/calendar.rs:186-200`

`is_confirmed_session_active` 窗口是「净值日 → 下一交易日 09:15」。QDII 的 `PDATE=08-05`，下一交易日 = 08-06，而今天是 08-07 → `today > next` → **false**。即：**QDII 的净值天生就在这个窗口外**。

#### 闸门 3：我们 2026-08-06 主动加的 `isQdii` 硬跳过

`packages/services/src/fund.ts:460-483`、`apps/tauri/src-tauri/src/providers/fund123.rs:349-362`

```rust
let in_confirm = !is_qdii && day_growth.is_some() && ... ;
// ...
} else if !is_qdii && day_growth.is_some() { (day_growth, None) }
else { (None, None) }        // ← QDII 落到这里，percent 永远为 None
```

动机正确（防止 fund123 `matiaria` 的昨日 `dayOfGrowth` 冒充今日涨幅），但**手段过重**：连「来自东财历史净值、日期明确的 `dayGrowth`」也一并封杀了。

### 2.3 两条链路的实际表现

| 链路 | prevNav | currNav | 收益额 | 涨跌幅 | 用户观感 |
|---|---|---|---|---|---|
| **FundMNFInfo 源**（默认） | `None` | 2.1749 | **0** | **空白** | 完全不动，晚上也不变 |
| **fund123 源** | 2.1920（hist 已取到） | 2.1749 | **能算出** | **空白** | 收益有数、涨跌幅空 → 割裂 |

> fund123 链路（`fund123.rs:313-372`）其实**已经是** wzk 那套 hist 结算逻辑，`prev_net_value` 是对的；唯独 `percent` 被闸门 3 掐掉，造成「有钱数没百分比」的诡异状态。FundMNFInfo 链路则**完全没有接入 hist**，是两条链路里更残缺的那条。

---

## 三、wzk-fund `8a86e1b` 的做法拆解

改动共 45 文件 / +6001 行，与 QDII 数据口径**真正相关**的只有 4 个机制：

### 机制 A：`ftype`（基金类型）作为一等公民

`server/src/services/fund.js:380-387` 从 `FundMNBasicInformation` 取 `FTYPE`（如 `QDII-普通股票`、`指数型-海外股票`），随行情返回并持久化到本地记录。配套 `h5/src/lib/fundCategory.ts`：

```ts
if (/QDII|海外/.test(`${ftype} ${name}`)) return 'QDII'
```

**关键点**：判定从「基金名」升级为「`FTYPE` + 基金名」双通道。

### 机制 B：`delayedDisclosure` 开关，绕开 A 股会话窗

`server/src/services/fund.js:1477-1500`

```js
export function isDelayedNavFund({fundType, ftype, name} = {}) {
  return /QDII|海外/.test(`${fundType || ''} ${ftype || ''} ${name || ''}`)
}
export function isConfirmedSessionActive(navDayRaw, now = new Date(), opts = {}) {
  const navDay = normalizeNetValueDate(navDayRaw, now)
  if (!navDay) return false
  if (opts.delayedDisclosure) return true     // ← QDII 直接放行
  // ... 原 A 股「下一交易日 09:15」窗口
}
```

### 机制 C：用历史净值序列取真实相邻净值，**禁止用涨幅反推**

`server/src/services/fund.js:1330-1349, 1399-1413`

```js
hist = await fetchFundNavHistory(code, 5)        // FundMNHisNetList
histIdx = hist.findIndex(h => h.date === navDay)
netValue   = hist[histIdx].netValue
dayGrowth  = hist[histIdx].dayGrowth
if (percentSource === 'confirmed') prevNetValue = hist[histIdx + 1].netValue  // 取真实前一日，禁止反推
```

注释里明确写了「**禁止用两位涨幅反推**」。这正是我们 `fundmnfinfo.rs:137` 在做的事：

```rust
parsed.prev_net_value = Some(round4(nav.unwrap() / (1.0 + nav_chg_rt.unwrap() / 100.0)));
```

**实测误差量化**（040046）：反推昨净值 8.303409 vs 真实 8.3030，持有 10000 份时收益额偏差 +4.09 元。量级不大但**系统性存在**。

### 机制 D：UI 分区 + 用户教育

- `splitHoldingsByRealtime` 把持仓拆成「可实时估值」/「QDII·海外」两组独立汇总。
- QDII 行标注**净值日期徽章**（如 `07-30`）。
- 585 行 Q&A 页文案口径值得吸收进我们的设置页说明。

---

## 四、逐条可行性评估（定稿）

| # | wzk 机制 | 决策 | 理由 |
|---|---|---|---|
| A | `FTYPE` 双通道识别 | ✅ **采纳** | 我们现只靠 `/QDII/i` 匹配名，「指数型-海外股票」类不含 QDII 字样会漏判。`FTYPE` 更权威；需持久化 + 缓存避免多一次请求。 |
| B | `delayedDisclosure` 绕开会话窗 | ✅ **采纳（核心）** | 直击闸门 2，A 股时间窗对 QDII 语义上不成立，是修正建模错误非 hack。 |
| B' | QDII「有披露即 confirmed」一刀切 | ❌ **不采纳** | wzk 的 `if (opts.delayedDisclosure) return true` 永不过期（停更一个月仍展示一月前涨幅）。**我们改为：靠「基金列次行显式日期」诚实标注，不自动隐藏、也不永不过期**——更简单且用户已确认只看数字。 |
| C | hist 取真实相邻净值，禁止反推 | ✅ **强烈采纳** | 直击闸门 1 数据缺口，顺带消除 §三-C 系统性误差。已有 `fetch_fund_nav_history`，fund123 链路已在用，只需接到 FundMNFInfo 链路。 |
| D | 净值日期徽章 | ✅ **采纳（位置 B）** | 日期放**基金列次行**（`净值08-05`），不放净值列（避免影响表宽）。仅 QDII 显示。 |
| D' | 585 行 Q&A 页 | ❌ **不采纳** | 体量与 popup 形态不匹配，文案口径吸收进设置页说明。 |
| — | wzk 的 `hasReplace` 处理 | ❌ **不适用** | wzk 服务端不以 `FundMNFInfo` 的 GSZ 为主口径；我们自行决定 `hasReplace` 改法（见 §七 P0-1）。 |

---

## 五、最终 QDII 展示规则（用户侧口径）

1. **非 QDII 基金**：保持现状——盘中走自算估值/fund123 分时估值；盘后官方净值披露后显示确认涨跌幅。
2. **QDII 基金（盘中）**：当日收益列显示 `-`（灰色）；最新净值列照常显示净值数字；基金列次行显示 `净值08-05`（滞后净值日，灰小字）。**不造盘中数字**。
3. **QDII 基金（盘后）**：当日收益列显示最新已披露净值日的真实变动（`NAVCHGRT` + 收益额）；基金列次行日期随 `PDATE` 更新（如当晚东财披露 08-06，则变为 `净值08-06`）。
4. **晚上刷新能否更新**：能。修掉 `has_replace` 死分支 + 盘后放行后，只要东财发布 QDII 新净值（哪怕延迟一天），下一次刷新即取到新 `PDATE`+`NAVCHGRT` 自动显示。延迟是 QDII 本身 T+1/T+2 特性，非我们的 bug——我们只是「接住」它。
5. **手续费/差异处理**：收益额公式对齐天天基金 `份额×(NAV−前一日NAV)−手续费−差异`（005698 案例 = 7256.37×(2.6338−2.6103)−1.50−0.01 = 169.02）。初期可先用反推昨净值跑通，精确值后续经 `FundMNHisNetList` 取真实前一日净值消除 4 元级误差。

---

## 六、分组当日收益额聚合排除 QDII（盘中）

**现状问题**：`packages/ui/src/lib/groupStats.ts` 的 `summarizeGroup` → `groupPnl`（`groupStats.ts:20-25`）对成员用 `row.pnl ?? 0` 求和。QDII 盘中 `pnl = null`，当前会**以 0 计入**分组当日收益额——既不完整（少算 QDII），又误导（让人以为该组当日总收益已全量）。

**决策**：分组当日收益额聚合时，**跳过当日收益为空的成员**（自然覆盖盘中 QDII）。盘后 QDII `pnl` 有值则正常计入。

- 实现上：将 `groupPnl` 的 `row.pnl ?? 0` 改为「`pnl == null` 时该成员不参与求和」（其余聚合逻辑不变）。
- 该规则对所有「当日收益为空」的基金通用（新基金/错误态同样跳过），不依赖新增 `isQdii` 标记，副作用最小。
- **仅影响「当日收益额」聚合**；累计收益（`cumPnl`，基于成本）不受影响。
- Tauri 侧 `menubar.rs::group_pnl`（menubar.rs:115-123）需同步同一规则（两端同构）。

---

## 七、分阶段执行方案

> 全部改动需 Tauri（Rust）+ Chrome（TS）**两端同构**，并同步 `CLAUDE.md` §估值兜底规则 与 `packages/ui/src/OptionsApp.tsx` 说明文案（项目硬约定：缺任一处视为未完成）。

### P0 —— 修复「数据已到手却被丢弃」（纯 Bug 修复，不变更展示口径）

**P0-1　解除 `hasReplace` 对 `GZTIME` 的依赖**

- 位置：`fundmnfinfo.rs:115` / `fund.ts:1144-1146`
- 方案：`GZTIME` 缺失时，改用 `PDATE` 与「当前交易日」比较判定是否已披露当日净值；`GZTIME` 存在时保持原逻辑（向后兼容）。
- 收益：让 `confirmed` 分支从死代码复活，`day_growth` 不再被丢弃（境内基金盘后也受益）。

**P0-2　FundMNFInfo 链路接入历史净值，停止反推昨净值**

- 位置：`fundmnfinfo.rs:132-139` / `fund.ts:1160-1168`；复用 `fetch_fund_nav_history` / `fetchFundNavHistory`
- 方案：对齐 `fund123.rs:313-341` 既有实现（`hist[idx]` 取 netValue/dayGrowth，`hist[idx+1]` 取 prevNetValue）。
- 性能：仅对「自算估值失败」的少数基金（QDII/黄金等）按需单只拉取，复用 5 分钟缓存 + 限流队列。

**P0 验收**：`016532` 在 FundMNFInfo 源下，`prev_net_value = 2.1920`（非反推 2.19199…），`net_value_date = 2026-08-05`。

### P1 —— 引入「延迟披露」模型（变更展示口径，已获用户确认）

**P1-1　新增 `is_delayed_nav_fund` / `isDelayedNavFund`**

- 判定：`FTYPE` 含 `QDII|海外` **或** 基金名含 `QDII|海外`（机制 A + B）
- 位置：`calendar.rs` / `packages/core` 日历模块，与 `is_confirmed_session_active` 同域
- 同时在抓取时给 `FundQuoteRow` 补 `isQdii?: boolean`（UI 区分用）

**P1-2　`is_confirmed_session_active` 增加 `delayed_disclosure` 参数**

- 位置：`calendar.rs:186` / TS 对应实现
- 行为：**不照搬 wzk 的 `return true`**，改为「QDII 直接视为已确认会话」（即盘后放行、盘中仍按盘中态显示 `-`）。日期靠 UI 基金列次行诚实标注，不做自动隐藏。

**P1-3　放宽闸门 3 的 `isQdii` 硬跳过**

- 位置：`fund.ts:460-483` / `fund123.rs:349-362`
- 方案：把「按基金类型跳过」改为「**按数据来源跳过**」——
  - 来自**东财 hist / `NAVCHGRT`** 的 `dayGrowth`：日期明确、口径可信 → **允许使用**，并下发 `netValueDate` 供 UI 标注；
  - 来自 **fund123 `matiaria.dayOfGrowth`**：日期不明、有「昨日冒充今日」风险 → **继续禁止**。

**P1-4　QDII 盘中/盘后展示分支**

- 盘中：`percent = null`，UI 渲染为 `-` 灰色；
- 盘后：取 `NAVCHGRT` 作为 `percent`，`percentSource = 'confirmed'`，收益额经 hist 真实前一日净值计算。

### P2 —— UI 与用户告知（必须与 P1 同批）

- **P2-1** QDII 行「基金列次行」显示 `净值08-05`（仅 QDII，灰小字）；最新净值列**不**加日期（避免影响表宽）。
- **P2-2** `summarizeGroup`/`groupPnl` 跳过当日收益为空的成员（§六）；Tauri `menubar.rs::group_pnl` 同步。
- **P2-3** `OptionsApp.tsx` 「估值兜底规则」说明补 QDII 新口径（硬约定，必做）。
- **P2-4** `CLAUDE.md` §估值兜底规则同步更新，并修正 `:164` 已失真描述。
- **P2-5**（可选）menubar/badge 是否计入 QDII 盘后收益——建议计入（与支付宝一致），设置页说明。

### P2 必做的兜底说明同步文案（实施时直接替换）

**`CLAUDE.md` 第 163 行（QDII 源内口径）替换为：**

> - **QDII 基金**（识别函数 `is_qdii_name` / `isQdiiName` 或 `FTYPE` 含 QDII/海外）：盘中无分时估值（fund123 实测 0 点、无重仓股无法自算）→ **当日收益显示「-」（灰色）**；盘后（官方净值披露后）改用**最新已披露净值日的日变动**展示当日收益（= `NAVCHGRT`，收益额 = 份额×(NAV−前一日NAV)−费用），与天天基金/支付宝一致。净值日期标注在基金列次行（如「净值08-05」）。**仍跳过 fund123 兜底**（其 `dayOfGrowth` 是 T+1 昨日涨幅，冒充今日会误导）。

**`CLAUDE.md` 第 164 行（兜底仍失败）替换为：**

> 4. **QDII 盘后兜底**：FundMNFInfo 在官方净值披露后（`confirmed` 分支复活，见上「`has_replace` 不再强赖 GZTIME」）即取 `NAV`+`NAVCHGRT` 作为最新已披露日变动；缺失前一日净值时经 `FundMNHisNetList` 取真实相邻净值（禁止用涨幅反推）。QDII 因 T+1/T+2 延迟，盘后数字对应滞后净值日（如 08-05），属正常，日期已标注。

**`CLAUDE.md` 第 169 行（fund123 源 QDII 口径）替换为：**

> - **QDII 口径**：盘中 percent 不显示（显示「-」，灰色），不认 fund123 `matiaria.dayOfGrowth`（T+1 昨日涨幅冒充今日）；盘后取 FundMNFInfo `NAVCHGRT` 作为最新已披露日变动（confirmed 分支），净值日期随行标注。

**`OptionsApp.tsx` 第 588 行替换为：**

> 估值兜底规则 · FundMNFInfo 源：盘中无估值时先用重仓股当日涨跌幅自算；自算失败时，非 QDII（黄金/商品 ETF 联接等）自动改用该基金的 fund123 官方分时估值。QDII 盘中无重仓股也无 fund123 分时估值，故**当日收益显示「-」（灰色）**；盘后（官方净值披露后）改用「最新已披露净值日的日变动」展示当日收益与涨跌幅（与天天基金/支付宝一致），净值日期标注在基金名下。

**`OptionsApp.tsx` 第 591 行替换为：**

> 估值兜底规则 · fund123 源：QDII 不显示昨日涨幅冒充今日（净值 T+1 披露），只认当日分时估值；该股源下 QDII 无分时估值时显示为「-」（灰色），盘后切换至 FundMNFInfo 同款「最新已披露净值日变动」口径。

---

## 八、风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| **口径变更引发困惑** | 用户会看到 QDII 显示滞后净值日的涨跌幅计入当日收益 | 基金列次行显式日期 `净值08-05` + 设置页说明；与支付宝口径一致可解释 |
| **N 只持仓 → N 个 hist 请求** | FundMNFInfo 批量优势被削弱 | 仅对自算失败的少数基金按需拉取 + 缓存 + 限流队列 |
| **P0-1 改动影响全体基金** | 境内基金 `confirmed` 分支也会复活 | 对境内基金回归：确认「盘中估值 → 晚间确认净值」切换时点仍正确 |
| **`FTYPE` 额外请求** | 多一个 `FundMNBasicInformation` 调用 | 随行情持久化到本地记录，仅首次/缺失时拉取 |
| **单向兜底约束** | 禁止 A↔B 来回 fallback | 新增均为东财内部 hist 补充，不跨源，不违反约束 |
| **分组聚合口径** | 跳过空 `pnl` 后盘前群组当日收益额可能小于全量 | 仅影响当日收益额（非累计），且盘后 QDII 有值时自动补回；与支付宝分组口径一致 |

---

## 九、验证清单（实施时使用）

- [ ] `016532` / `005698`（QDII，PDATE 落后）：FundMNFInfo 源与 fund123 源**显示一致**，盘后 `+0.90%` + 日期 `净值08-05`
- [ ] `005698` 盘后收益额 ≈ `+169.02`（对齐天天基金），手续费/差异已计入
- [ ] `100050`（QDII 债券，涨幅 -0.02% 极小）：`prevNav` 取自 hist 而非反推，收益额无 4 元级偏差
- [ ] `161725`（境内 LOF）：盘中仍走自算估值，晚间切换确认净值时点正确，**未被 P0-1 改动破坏**
- [ ] `008987`（黄金联接，非 QDII 但无重仓股）：fund123 fallback 链路未受影响
- [ ] QDII **盘中**：当日收益列显示 `-`（灰色），基金列次行 `净值08-05`
- [ ] **分组聚合**：含 QDII 的分组，盘中当日收益额不含 QDII 的 0 占位；盘后自动计入
- [ ] 无持仓 / 新基金 / 停更基金：不崩溃，不出现 `NaN`
- [ ] `pnpm -r typecheck` + `pnpm --filter @fund01/chrome build` + `cargo check`
- [ ] 两端同构 diff review：Rust 与 TS 逻辑逐行对应
- [ ] `CLAUDE.md` 与 `OptionsApp.tsx` 文案已按 §七 P2 同步

---

## 十、设置界面「数据说明」Tab 设计方案（已先行实现）

### 10.1 需求来源与状态

- **需求**：在设置界面新增一个「数据说明」tab，集中展示我们的计算规则/数据口径，供用户理解收益数字从何而来。参考 `wzk-fund/h5/src/pages/FundQaPage.tsx` 的 Q&A 框架——但**未照抄**其「证书图标」「本页」等 wzk 专属概念，按本项目 UI（Radix Tabs + 现有 `SectionCard`）改写适配。
- **状态（重要）**：本会话中此 tab 已被**先行实现**（用户原意是"先写进文档"，本应文档先行；现将方案补入文档并标注现状）。代码已落地，`pnpm -r typecheck` 全绿、`pnpm --filter @fund01/chrome build` 通过（v1.2.24）。
- **口径衔接**：tab 内 QDII 两条文案按 §一~§七 的**目标方案**撰写（盘中 `-`/盘后最新已披露净值日变动/基金名下行日期/分组排除空值）；而 QDII 计算逻辑**尚未改**（仍在等你确认 §七 后再动）。故当前 tab 文案与实际界面**暂不完全一致**——待 QDII 改造实施、且 §七 P2-3/P2-4 同步 `OptionsApp.tsx`/`CLAUDE.md` 兜底说明后，三者（tab 补充说明 / 数据源下方简明规则 / 实际行为）才会完全对齐。

### 10.2 Tab 定义

| 项 | 值 |
|---|---|
| `id` | `'docs'` |
| `label` | 数据说明 |
| `icon` | `Info`（`lucide-react`，与现有 `Settings2/FolderTree/Menu/Database` 风格一致） |
| 平台 | chrome / tauri 均显示（同「备份」tab，不参与平台过滤） |
| 深链 | `openSettings('docs')` + `?tab=docs` 可直接打开（popup 无需改动） |

### 10.3 内容（7 个折叠项，参考 wzk 框架改写）

| 折叠项 | 对应 wzk | 本项目写法要点 |
|---|---|---|
| 数据来源与口径 | — | FundMNFInfo vs fund123；盘中分时均走 fund123；预估≠官方净值，以官方披露为准 |
| 盘中估值 vs 官方净值 | a-share | 境内基金两条口径；时间线 09:30–15:00 / 当晚披露 / 次日 09:15 前 |
| 估值兜底规则 | — | FundMNFInfo 源自算失败→fund123 兜底（非 QDII）；QDII 盘中 `-`、盘后最新已披露净值日变动 |
| QDII 为什么慢一天 | qdii-delay | T+1/T+2 延迟披露，白天无可靠今估值；不套 A 股次日 09:15 窗口 |
| QDII 当日收益怎么算 | qdii-pnl | 份额×(最新−上一净值)，是「最近一次已披露净值变动」，非盘中实时估 |
| 分组收益额怎么算 | async-nav | Σ 各成员当日收益，跳过空值（盘中 QDII 不计入） |
| 刷新与更新时间 | us-time | 20:00 后起更新真实净值；美股 QDII 约北京时间次日晚披露 |

### 10.4 实现要点

- **折叠交互**：用原生 `<details>/<summary>`（零依赖、最稳），规避我们 `tw-shim.css`「类名缺失静默失败」的坑。所用原子类（`border-line/70`、`border-line/60`、`leading-relaxed`、`justify-between` 等）已逐一核对在白名单内。
- **组件**：`DocItem`（单个折叠项）+ `DataDocsSection`（7 项容器，套 `SectionCard`），位于 `OptionsApp.tsx`。
- **接线 4 步**：
  1. `packages/core/src/port.ts:62` — `SettingsTabId` 联合类型加 `'docs'`；
  2. `OptionsApp.tsx` `TABS` 数组（约 :73）加 `{id:'docs', label:'数据说明', icon:Info}`；
  3. 加 `<Tabs.Content value="docs"><DataDocsSection/></Tabs.Content>`；
  4. 新增 `DataDocsSection` 组件（`OptionsApp.tsx:1702-1810`）。

### 10.5 与其它说明的关系（硬约定）

- 现有「数据源」下方「估值兜底规则」简明文案（`OptionsApp.tsx:588-594`）+ `CLAUDE.md` §估值兜底规则 是**兜底规则的权威落点**，按 `MEMORY.md` 工作约定**必须保留**（§七 P2-3/P2-4 会同步更新它们）。
- 本 tab **仅作补充教育**，不替代、不删除上述权威说明；二者内容同源、互不冲突。

### 10.6 后续待办（不阻塞本 tab）

- [ ] QDII 计算逻辑按 §七 实施后，复核 tab 内 QDII 两条文案与真实行为一致；
- [ ] 若届时希望 tab 文案与「数据源下方简明规则」完全同文，可抽公共常量（可选，非必须）。

---

## 十一、QDII 净值披露观察记录（2026-08-07，进行中）

> 本节为**实施后的实测观察记录**，记录「披露日窗口」规则在真实数据下的表现，并列出待回填的观察项。观察结果由用户确认后回填。

### 11.1 已确认（2026-08-07 傍晚，用户实测确认）

东财周五（08-07）已**陆续披露**部分 QDII 的 08-06 净值，popup 与天天基金表现一致：

| 基金 | PDATE | popup 当日收益 | 天天基金 | 结论 |
|---|---|---|---|---|
| 016532 嘉实纳斯达克100ETF联接(QDII)A | 08-06（今日披露） | -44.26 / -0.36% | 已更新，对得上 | ✅ 披露日窗口判定正确 |
| 012922 易方达全球成长精选混合(QDII)C | 08-06（今日披露） | -2.13 / -0.04% | 已更新，对得上 | ✅ 披露日窗口判定正确 |
| 005698 / 040046 | 08-05（昨日披露） | `-`（灰） | 未更新 08-06 | ✅ 今日无新披露 → 正确保持 `-` |
| **100050** 富国全球债券(QDII)A | **08-06（18:14 前后披露）** | **-0.31%**（当日收益） | 已更新，对得上 | ✅ 用户确认（仅天天基金 app 显示延迟） |
| **022184** 富国全球科技互联网股票(QDII)C | **08-06（18:14 前后披露）** | **-2.89%**（当日收益） | 已更新，对得上 | ✅ 用户确认（仅天天基金 app 显示延迟） |

### 11.2 观察事项完成情况（100050 / 022184）

QDII 净值是**逐个/分批披露**的（同一批基金更新时间不同）。四项观察点均已验证通过：

- [x] **披露时点**：100050 / 022184 于 08-07 18:14 前后披露 08-06 净值（当晚即出，未拖到周一）。
- [x] **popup 自动切换**：东财披露后 popup **无需手动操作**自动从 `-` 变为当日收益数字，基金列次行日期自动变为「净值08-06」。
- [x] **与天天基金一致性**：用户确认净值与收益**对得上**——天天基金 app 仅**显示延迟**（数据同源 `FundMNFInfo` 官方净值差，晚于东财接口更新），非口径差异。
- [x] **分组聚合自动计入**：当日收益从 `-` 变为数字后，分组「当日收益额」自动计入这两只。

**判定标准**：若东财 `FundMNFInfo` 已返回 `PDATE=2026-08-06`（可用接口实测确认），而 popup 仍显示 `-` → 属 bug（判定或缓存问题），需按 §九 验证清单排查；若东财同样未更新 → 属数据源滞后，行为正确。

### 11.3 观察结果回填（2026-08-07 18:14 实测）

- **100050 / 022184 已于 18:14 前后披露 08-06 净值**（实测 `FundMNFInfo` 返回 `PDATE=2026-08-06`，`NAVCHGRT=-0.31/-2.89`）→ popup 无需手动操作即显示当日收益，基金列次行日期自动变「净值08-06」——**披露日窗口自动切换生效，与天天基金同源一致**。
- 005698 / 040046 截至 18:14 仍未披露 08-06 → 保持 `-`，行为正确。
- 印证：QDII 净值**分批披露**（16:00 前仅 2 只 → 18:14 增至 4 只 → 其余待晚间/周一），「披露日窗口」判定全程正确切换。
- **用户最终确认（18:34）**：100050 / 022184 的净值与收益**均对得上**，此前天天基金 app 未显示只是其**更新延迟**，非口径差异。观察闭环 ✅。

### 11.4 遗留问题修复（2026-08-07 18:14，fund123 源 calc 层回退）

**现象**：切换数据源为 fund123 后，005698（PDATE=08-05 昨日披露）显示 +161.53 / +0.90%，未显示 `-`。

**根因**：provider 层（fund123 源）已按披露日窗口正确给出 `percent=null`，但 **calc 层三连回退**把 `dayGrowth` 又捞了回来：

- TS `packages/core/src/holdingsCalc.ts:105`（calcHoldings）与 `:269`（mergeWatchlist）：`q.percent ?? q.estimateGrowth ?? q.dayGrowth ?? null`
- Rust `apps/tauri/src-tauri/src/calc.rs:80`：`q.percent.or(q.estimate_growth).or(q.day_growth)`

QDII 未披露日 `dayGrowth`（东财 hist 滞后净值日涨幅 0.90）被回退成 `percent` → 冒充「当日」。FundMNFInfo 源恰好不中招（其 `has_replace=false` 时 `day_growth=None`），所以两源表现不一致。

**修复**（v1.2.31，双端同构）：
1. calc 层 percent **不再回退 dayGrowth**（只认 `percent ?? estimateGrowth`；provider 层已完备定义展示口径：confirmed / estimate / 非 QDII dayGrowth 兜底由 provider 决定）；
2. **percent 为 null 时 pnl 同步置 null**（当日收益无展示意义：UI 渲染「-」、分组 `groupPnl`/menubar `per_share_pnl` 跳过），避免 fund123 源 005698 的 +161.53 滞后净值差被计入「当日」与分组聚合。

**验证（本地真实接口，`pnpm dlx tsx` 直跑 provider + calc 层）**：fund123 源下 005698/040046/100050/022184（PDATE=08-05）→ `percent=null`、`pnl=null`；016532/012922（PDATE=08-06）→ `percent=-0.36/-0.04 (confirmed)`、pnl 正常；`summary.totalPnl` 只含有效披露日基金。FundMNFInfo 源回归一致。

**对非 QDII 的附带行为变化**：FundMNFInfo 源下黄金等无重仓股基金，在「自算失败 + fund123 兜底亦不可用」时，原 calc 层回退会显示 hist 昨日涨幅（如 008987 +1.95%），现如实显示 `-`（当日净值未披露）——与「当日收益」label 语义一致，属修正而非回归。

> ✅ **用户实测确认（2026-08-07 18:20）**：v1.2.31 卸载重装后，fund123 源下 QDII 未披露日显示 `-` 正常，两源行为一致。

---

## 附：关键代码位置索引

**我们的项目**

| 文件 | 行 | 内容 |
|---|---|---|
| `apps/tauri/src-tauri/src/providers/fundmnfinfo.rs` | 115 | `has_replace`（闸门 1） |
| 同上 | 132-139 | 反推昨净值 |
| 同上 | 452-458 | QDII 跳过 fund123 fallback |
| `apps/tauri/src-tauri/src/calendar.rs` | 186-200 | `is_confirmed_session_active`（闸门 2） |
| `apps/tauri/src-tauri/src/providers/fund123.rs` | 313-372 | **已有的** hist 结算逻辑（可作模板） |
| 同上 | 349-362 | `is_qdii` 硬跳过（闸门 3） |
| `apps/tauri/src-tauri/src/history.rs` | 49 | `fetch_fund_nav_history` |
| `apps/tauri/src-tauri/src/menubar.rs` | 115-123 | `group_pnl`（分组收益额，需同步 §六） |
| `packages/services/src/fund.ts` | 1144-1146 | `hasReplace`（闸门 1，TS） |
| 同上 | 1160-1168 | 反推昨净值（TS） |
| 同上 | 460-483 | `resolveDisplayPercent` + `isQdii`（闸门 3，TS） |
| 同上 | 528 / 697-727 | `fetchFundNavHistory` 与 hist 结算（TS 模板） |
| `packages/ui/src/lib/groupStats.ts` | 20-25 / 98 | `groupPnl` / `summarizeGroup`（分组聚合，§六） |
| `packages/core/src/types.ts` | 34-38 / 234 | `FundQuoteRow`：`percent`/`netValueDate`，需补 `isQdii?` |

**参考项目 wzk-fund**

| 文件 | 行 | 内容 |
|---|---|---|
| `server/src/services/fund.js` | 380-387 | `fetchFundFtype` |
| 同上 | 1167-1174 | `fetchFundNavHistory` |
| 同上 | 1330-1349 | hist 对齐净值 |
| 同上 | 1399-1413 | prevNetValue 取 `hist[idx+1]`，禁止反推 |
| 同上 | 1477-1500 | `isDelayedNavFund` / `isConfirmedSessionActive` |
| 同上 | 1506-1525 | `resolveDisplayPercent` |
| `h5/src/lib/fundCategory.ts` | 全文 | 分类 + `isRealtimeHolding` |
| `h5/src/lib/tradingCalendar.ts` | 50-100 | `isDelayedNavFund` / 徽章判定 |
| `h5/src/lib/holdingsCalc.ts` | 302-314 | `splitHoldingsByRealtime` |
| `h5/src/pages/FundQaPage.tsx` | 200-270 | QDII 口径文案 |
