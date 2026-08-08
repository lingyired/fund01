# 添加持仓页 Spec（聚焦文档，补充于总 spec 之后）

> 本文档是 `持仓录入展示统一-spec.md` 的**补充**，只聚焦「设置页 → 添加持仓」这一个页面。
> 总 spec 已定稿（未改动）。本页已对齐为「持有金额 + 持有收益」，不再是旧的「持有金额 + 成本单价」。
> 状态：已实现（代码现状即 as-built）。

---

## 1. 核心结论

设置页「添加持仓」（`OptionsApp.tsx` 的 `AddFundSection` → `FundFormBody` mode="hold"）的可编辑字段为：

```
基金代码 · 分组（单选）· 金额口径(prev/today) · 持有金额 · 持有收益（可选）
```

**成本单价不再手填**：它由「持有金额 − 持有收益」反推得到；若持有收益留空，则不统计持有收益（成本单价按市值自动派生但无收益锚，UI 显示「--」）。这与编辑页、popup 弹层、导入模块口径完全一致（总 spec **D2**）。

---

## 2. 字段定义

| 字段 | 可编辑？ | 说明 |
|---|---|---|
| 基金代码 | ✅ | 6 位数字，必填 |
| 分组 | ✅ | 单选；本次金额计入该分组份额 |
| 金额口径 | ✅ | prev=昨确认净值 / today=今确认净值（折算份额用） |
| 持有金额 | ✅ | = 当前市值；必填 |
| 持有收益 | ✅（可选） | = 当前市值 − 成本本金；留空则不统计持有收益 |

UI 位置（`FundFormDialog.tsx`）：金额口径 `:232-256`、持有金额 `:257-274`、持有收益 `:275-294`。

---

## 3. 数据流（提交时）

`AddFundSection` 调 `createFund(ports, {code, amount, amountBasis, group, holdProfit})`，落库逻辑在 `fundOps.ts`（`createFund`）：

```
shares    = 持有金额 ÷ 基准净值（按 amountBasis 选 prev/today 净值）
持有收益   = 录入值（holdProfit）
成本单价   = 持有收益已填 → (持有金额 − 持有收益) ÷ 份额
            持有收益留空 → 不统计（无原成本可保留，成本单价不落库）
```

成本优先级（fundOps `:347-357`）：`显式 cost > holdProfit 反推 > 保留 prev`。添加页只传 `holdProfit`，故走「holdProfit 反推」分支；留空则落入「保留 prev」（新基金无 prev → 不统计）。

---

## 4. 关键代码文件

| 文件 | 位置 | 职责 |
|---|---|---|
| `packages/ui/src/components/FundFormDialog.tsx` | `FundFormBody`（hold 模式） | 渲染字段；`Payload.holdProfit` 替代原 `cost`；提交构造 `payload.holdProfit` |
| `packages/ui/src/OptionsApp.tsx` | `AddFundSection` `:902-942` | 内联 `FundFormBody`，`createFund` 传 `holdProfit` |
| `packages/ui/src/lib/fundOps.ts` | `createFund` `:239-369` | 份额折算 + 成本反推（支持 holdProfit） |

存储模型不变：`allocations[group]=shares` + `costs[group]=costPrice`。

---

## 5. 与总 spec 的关系

- 落实总 spec **D2**（统一录入 = 持有金额 + 持有收益），补全了全家最后一个未统一入口（编辑页 / popup 弹层 / 导入 此前已统一）。
- 金额口径选择器（prev/today）保留，与 popup 弹层 `amountBasis` 一致（总 spec §7）。
- 成本单价降为派生值，不再手填（与「持有收益=当前市值−成本本金」语义一致）。

---

## 6. 已知差异 / 注意

1. **新基金持有收益留空**：无原成本可「保留」，故留空 = 完全不统计持有收益（显示「--」）。这与编辑页「留空保留原成本」语义不同，但编辑页有原值可保留、添加页没有，属合理差异。
2. **无只读派生列**：添加页是单笔新建，不展示已派生的份额/成本（提交后才出现在列表/编辑页）。如需实时预览可在后续补，非阻塞。
3. **原 `cost` 字段入口已从 UI 移除**，但 `createFund` 仍保留 `cost` 优先级（供导入等其它路径使用），未删除。
