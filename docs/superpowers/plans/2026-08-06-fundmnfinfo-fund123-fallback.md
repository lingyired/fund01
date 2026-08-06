# FundMNFInfo 自算失败时 fallback 到 fund123 官方估值 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FundMNFInfo 数据源的基金在「自算估值失败」（无重仓股可加权）时，fallback 到 fund123（蚂蚁基金）的分时估值接口，为该基金补齐盘中/收盘后的当日估值与收益率，使黄金/商品等无股票重仓的基金（如 008987）也能显示当日收益，且用的是**基金自身官方估值**（非跨源近似）。

**Architecture:** 现状链路是 FundMNFInfo（GSZ 缺失）→ 自算估值（重仓股涨跌幅加权）→ 失败则无估值。本方案在「自算估值失败」的出口处追加一道 fallback：用该基金的 `fund_key` 调 fund123 `queryFundEstimateIntraday`（分时估值，已实测 008987 有效：218 点、估值净值≈1.947、+2.29%），取末点填充 `estimateGrowth / estimateNetValue / percent(estimate)`，下游 `resolveNavPair` / `calc_holdings` 零改动。触发信号就是「自算失败」本身（=无重仓股=需要兜底的基金），普通基金（自算成功）完全不受影响。

**Tech Stack:** Rust（Tauri v2，fundmnfinfo.rs / fund123.rs 同 crate）、TypeScript（Chrome，services/fund.ts）、fund123 CSRF + 全局串行锁（已有实现，直接复用）。

## Global Constraints

- 依赖：不新增 crate；复用 `fund123.rs`（Tauri）与 `fund.ts`（Chrome）已有的 `get_fund_estimate_intraday` / `search_fund`（均 pub/export）
- 触发条件：仅 `useCalcNeeded && estimateGrowth == null && netValue > 0` **且自算估值返回 null** 时触发；自算成功的基金不触发（保持现有行为与性能）
- 不改动：`calc.rs` / `holdingsCalc.ts` 的净值/收益计算（下游零改动）、menubar/format 规则、Chrome 侧已有逻辑
- fund123 限制：接口有频率风控（403），`fund123_post` 内部已有 CSRF 缓存（10 分钟）+ 全局互斥锁（串行）；fallback 只在自算失败时发生（数量少），串行可接受
- 已知边界：QDII（净值延迟一天）fund123 大概率也无盘中估值，fallback 失败后保持现状（行业惯例）
- 验证：`cargo check` 0 警告 + `pnpm -r typecheck` 全绿 + 盘中/收盘实测 008987
- 提交：conventional 前缀 + 中文标题，身份 `lingyired <lingyired@users.noreply.github.com>`
- 版本：完成后 bump services 1.0.1、chrome 1.2.18、tauri 1.0.6（Cargo.toml / tauri.conf.json / Cargo.lock 三处）

---

## 背景（决策依据）

- 008987（广发上海金ETF联接C）已实测：`FundMNInverstPosition` 返回 `fundStocks/fundboods/fundfofs` 全空 + `ETFCODE=518600`，且标的 ETF 518600 也全空——东财该接口只覆盖股票/债券/FOF，**不覆盖商品（黄金现货）**，自算估值结构性失败。
- fund123 `queryFundEstimateIntraday` 对 008987 实测有效（218 个分时点、估值净值≈1.947、涨幅≈+2.29%，与黄金真实涨幅一致）——**基金自身官方估值**。
- 用户已否决 AU9999 跨源近似（20f174d 已回滚）与 rquest 指纹模拟（Plan 已删）。本方案是第三条路：**数据源 fallback**（官方估值，非近似）。

---

### Task 1: Tauri — fundmnfinfo 自算失败后 fallback fund123 分时估值

**Files:**
- Modify: `apps/tauri/src-tauri/src/providers/fundmnfinfo.rs`（`fetch_one` 自算估值 fallback 分支，L436-455 附近）

**Interfaces:**
- Consumes:
  - `crate::providers::fund123::get_fund_estimate_intraday(fund_key: &str) -> Result<(Vec<TrendPoint>, Option<TrendPoint>), String>`（fund123.rs L208，pub 已有）
  - `crate::providers::fund123::search_fund(code: &str) -> Result<SearchFundResult, String>`（fund123.rs L111，pub 已有；`SearchFundResult.fund_key: String`）
  - `FundQuoteInput.fund_key: Option<String>`（fundmnfinfo.rs 已有，refresh.rs `to_input` 已从 config 传入）
  - `TrendPoint { time: String, growth: Option<f64>, net_value: Option<f64> }`（model.rs）
- Produces: `fetch_one` 在自算失败时可能填充 `estimate_growth / estimate_net_value / percent(percent_source="estimate")`；`use_calc` 复用为 true 以标记「兜底来源」（调试日志可区分）

- [x] **Step 1: 在自算估值失败分支追加 fund123 fallback**

`fundmnfinfo.rs::fetch_one`（L436-455），把「自算估值失败」的 else 分支改为先试 fund123：

```rust
    // 自算估值 fallback（空窗期/估值过期）
    let mut use_calc = false;
    if use_calc_needed && estimate_growth.is_none() && net_value.is_some_and(|n| n > 0.0) {
        if let Some(calc_gszzl) = get_calc_gszzl(&code).await {
            if calc_gszzl.is_finite() {
                let calc_gsz = round4(net_value.unwrap() * (1.0 + calc_gszzl / 100.0));
                estimate_growth = Some(calc_gszzl);
                estimate_net_value = Some(calc_gsz);
                percent = Some(calc_gszzl);
                percent_source = Some("estimate".to_string());
                use_calc = true;
                #[cfg(debug_assertions)]
                eprintln!("[fund01] FundMNFInfo 自算估值成功 code={code} calc_gszzl={calc_gszzl} calc_gsz={calc_gsz}");
            } else {
                eprintln!("[fund01] FundMNFInfo 自算估值非有限值 code={code} calc_gszzl={calc_gszzl}");
            }
        } else {
            // 自算失败（无重仓股可加权：黄金/商品/QDII 等）→ fallback fund123 官方分时估值
            match fund123_estimate_fallback(&code, &fund).await {
                Some((eg, en)) => {
                    estimate_growth = Some(eg);
                    estimate_net_value = Some(en);
                    percent = Some(eg);
                    percent_source = Some("estimate".to_string());
                    use_calc = true;
                    eprintln!("[fund01] FundMNFInfo 自算失败→fund123 兜底成功 code={code} growth={eg} est_net={en}");
                }
                None => {
                    eprintln!("[fund01] FundMNFInfo 自算估值失败 code={code}（无重仓股/无股票行情/请求失败，fund123 兜底亦不可用）");
                }
            }
        }
    }
```

- [x] **Step 2: 新增 fallback 辅助函数**

在 `fundmnfinfo.rs` 文件内（`fetch_one` 之后）新增：

```rust
/// fund123 分时估值兜底：自算估值失败（无股票重仓）时，用该基金在蚂蚁基金的
/// 官方分时估值（queryFundEstimateIntraday 末点）补估算净值与涨幅。
/// 返回 (估算涨幅%, 估算净值)；fund_key 缺失时用 searchFund 补查；失败返回 None。
async fn fund123_estimate_fallback(
    code: &str,
    fund: &FundQuoteInput,
) -> Option<(f64, f64)> {
    use crate::providers::fund123;
    // 1. 确保 fund_key（config 已存则直接用，否则 searchFund 补查）
    let mut fund_key = fund.fund_key.clone().unwrap_or_default();
    if fund_key.is_empty() {
        match fund123::search_fund(code).await {
            Ok(s) => fund_key = s.fund_key,
            Err(_) => return None,
        }
    }
    if fund_key.is_empty() {
        return None;
    }
    // 2. 拉分时估值，取末点
    match fund123::get_fund_estimate_intraday(&fund_key).await {
        Ok((_, Some(latest))) => {
            let growth = latest.growth?;
            let est_net = latest.net_value?;
            if growth.is_finite() && est_net.is_finite() && est_net > 0.0 && growth.abs() < 30.0 {
                Some((growth, est_net))
            } else {
                None
            }
        }
        _ => None,
    }
}
```

注意：`fund` 参数即 `fetch_one` 的 `fund: &FundQuoteInput`，`fund.fund_key` 已由 refresh.rs `to_input` 从 config 传入（008987 的 config 有 fundKey）。

- [x] **Step 3: 编译验证**

Run: `cd apps/tauri/src-tauri && cargo check`
- 预期：0 警告（若 `TrendPoint` 字段名有出入，按 model.rs 实际字段修正 `latest.growth / latest.net_value`）

- [ ] **Step 4: 盘中实测（开盘时段）**

- debug 运行 `pnpm --filter @fund01/tauri tauri dev`
- 确认日志出现 `自算失败→fund123 兜底成功 code=008987 growth=... est_net=...`，且 popup 008987「当日收益/涨跌幅」恢复显示（估值口径 = fund123 官方值）

- [x] **Step 5: Commit**

```bash
git add apps/tauri/src-tauri/src/providers/fundmnfinfo.rs
git commit -m "feat(tauri): 自算估值失败时 fallback fund123 官方分时估值（008987 等商品基金）"
```

---

### Task 2: Chrome — services/fund.ts 同步 fallback

**Files:**
- Modify: `packages/services/src/fund.ts`（`FundMNFInfoQuoteProvider.fetchOne` 自算估值分支，L1223-1240 附近）

**Interfaces:**
- Consumes:
  - `getFundEstimateIntraday(fundKey: string): Promise<{points: {time:string;growth:number|null;netValue:number|null}[]; latest: {time:string;growth:number|null;netValue:number|null}|null}>`（fund.ts L614，export 已有；growth 已 ×100 为百分数值）
  - `searchFund(code: string)`（fund.ts L84，export 已有；返回 `{fundKey, name, netValue, dayGrowth}`）
  - `FundQuoteInput.fundKey?: string`
- Produces: `fetchOne` 自算失败时可能填充 `estimateGrowth / estimateNetValue / percent(percentSource="estimate")`；`useCalc` 置 true

- [x] **Step 1: 自算失败分支追加 fund123 fallback**

`fund.ts` 的 `fetchOne`（L1230-1240），把 `getCalcGszzl` 失败的 else 分支改为试 fund123：

```ts
    let useCalc = false
    if (useCalcNeeded && estimateGrowth == null && netValue != null && netValue > 0) {
      const calcGszzl = await getCalcGszzl(code)
      if (calcGszzl != null && Number.isFinite(calcGszzl)) {
        const calcGsz = Math.round(netValue * (1 + calcGszzl / 100) * 10000) / 10000
        estimateGrowth = calcGszzl
        estimateNetValue = calcGsz
        percent = calcGszzl
        percentSource = 'estimate'
        useCalc = true
      } else {
        // 自算失败（无重仓股可加权：黄金/商品/QDII 等）→ fallback fund123 官方分时估值
        const est = await fund123EstimateFallback(code, fund.fundKey)
        if (est) {
          estimateGrowth = est.growth
          estimateNetValue = est.netValue
          percent = est.growth
          percentSource = 'estimate'
          useCalc = true
          console.warn(`[fund01] FundMNFInfo 自算失败→fund123 兜底成功 code=${code} growth=${est.growth} est_net=${est.netValue}`)
        }
      }
    }
```

- [x] **Step 2: 新增 fallback 辅助函数**

在 `fund.ts` 文件内新增（`getCalcGszzl` 定义附近）：

```ts
/** fund123 分时估值兜底：自算估值失败（无股票重仓）时，用该基金在蚂蚁基金的
 *  官方分时估值（queryFundEstimateIntraday 末点）补估算净值与涨幅。
 *  返回 {growth(%), netValue}；fundKey 缺失时用 searchFund 补查；失败返回 null。 */
async function fund123EstimateFallback(
  code: string,
  fundKey?: string,
): Promise<{growth: number; netValue: number} | null> {
  let key = fundKey || ''
  if (!key) {
    try {
      const s = await searchFund(code)
      key = s.fundKey
    } catch {
      return null
    }
  }
  if (!key) return null
  try {
    const {latest} = await getFundEstimateIntraday(key)
    const g = latest?.growth
    const n = latest?.netValue
    if (g != null && n != null && Number.isFinite(g) && Number.isFinite(n) && n > 0 && Math.abs(g) < 30) {
      return {growth: g, netValue: n}
    }
  } catch {
    // fall through
  }
  return null
}
```

- [x] **Step 3: 编译验证**

Run: `cd /Users/lingsmbp/Documents/aiwork/fund01 && pnpm -r typecheck`
- 预期：全绿（若 `searchFund` 返回结构字段名有出入，按 L84-129 实际实现修正）

- [ ] **Step 4: 实测（与 Task 1 Step 4 同时段）**

- 重新 build chrome（`pnpm --filter @fund01/chrome build`），重新加载扩展
- 确认 008987 当日收益恢复（fund123 官方估值口径），且 Network 出现 `queryFundEstimateIntraday` 请求

- [x] **Step 5: Commit**

```bash
git add packages/services/src/fund.ts
git commit -m "feat(chrome): 自算估值失败时 fallback fund123 官方分时估值"
```

---

### Task 3: 全量验证 + 版本 bump + 收尾

**Files:**
- Modify: `packages/services/package.json`（1.0.0 → 1.0.1）
- Modify: `apps/chrome/package.json`（1.2.17 → 1.2.18）
- Modify: `apps/tauri/src-tauri/Cargo.toml` / `tauri.conf.json`（1.0.5 → 1.0.6，Cargo.lock 由 cargo 同步）

**Interfaces:** 无新接口；收尾验证

- [x] **Step 1: 全量验证**

Run:
```bash
cd /Users/lingsmbp/Documents/aiwork/fund01 && pnpm -r typecheck
cd apps/tauri/src-tauri && cargo check && cargo test
```
- 预期：typecheck 全绿、cargo check 0 警告、既有 cargo test 通过

- [x] **Step 2: 版本 bump**

- services 1.0.1、chrome 1.2.18、tauri Cargo/conf 1.0.6（cargo check 同步 lock）

- [x] **Step 3: 构建验证**

Run: `pnpm --filter @fund01/chrome build && pnpm --filter @fund01/tauri build`
- 预期：chrome manifest 同步 1.2.18、tauri 前端构建成功

- [x] **Step 4: 提交**

```bash
git add packages/services/package.json apps/chrome/package.json \
        apps/tauri/src-tauri/Cargo.toml apps/tauri/src-tauri/Cargo.lock apps/tauri/src-tauri/tauri.conf.json
git commit -m "chore: bump services 1.0.1 / chrome 1.2.18 / tauri 1.0.6"
```

- [ ] **Step 5: 交付（用户执行）**

- Tauri：`pnpm --filter @fund01/tauri tauri build` 打正式包，盘中+收盘各观察一轮 008987 当日收益
- Chrome：重载扩展（`apps/chrome/dist`），确认 008987 当日收益恢复

---

## 回滚方案

- 代码回滚：`git revert` Task 1 / Task 2 的 commit（各只动一个文件，干净）
- 行为回退：撤销后 FundMNFInfo 回到「自算失败即无估值」现状（008987 收盘后无当日收益，晚间净值披露后自动有），两端一致

## 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| fund123 频率风控（403） | fallback 失败 → 008987 仍无估值 | 只在自算失败时触发（数量少）；`fund123_post` 已有 CSRF 刷新重试 |
| fund123 串行锁拖慢刷新 | 自算失败基金多时排队 | 自算失败 = 无重仓基金（黄金/商品/QDII），量小；且单只仅 1~2 个请求 |
| QDII 无 fund123 估值 | fallback 失败 → 保持现状 | 行业惯例（净值延迟一天），符合预期，不视为缺陷 |
| fund123 页面/接口改版 | searchFund/matiaria 相关变化 | 仅用 queryFundEstimateIntraday（POST JSON，稳定）；失败降级为现状 |
| fund_key 缺失 | 多一次 searchFund 请求 | 008987 config 已存 fundKey；缺失时补查一次（可接受） |
| 估值口径差异（fund123 vs 东财确认净值） | 盘中显示 fund123 官方估值 | 本身即基金官方估值；20:00 后 confirmed 分支自动切换官方确认净值 |
