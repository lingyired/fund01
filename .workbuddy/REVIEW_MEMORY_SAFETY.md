# Fund01 代码审查报告：内存占用 & 代码安全

> 审查日期：2026-08-04 ｜ 范围：`packages/core`、`packages/services`、`packages/ui`、`apps/chrome`、`apps/tauri`（TS + Rust 全量）
> 结论：未发现致命漏洞；无 XSS 入口；主要问题集中在**常驻缓存无界增长**、**监听器泄漏**、**大数组一次性加载**。以下均为「待调整清单」，未做任何修改。

> **修复进度（2026-08-04 晚，分支 `refactor/memory-safety`，提交 `d4a082a`）**：
> ✅ 1 / ✅ 2 / ✅ 3（后端降采样 + since minCount；前端全区间预取保留，依赖后端收敛） / ✅ 4 / ✅ 5 / ✅ 6 / ✅ 7 / ✅ 8 / ✅ 9 / ✅ 10（顺带）
> ⬜ 未做（有意保留）：前端走势弹窗改为按 tab 点击懒加载（会丢失 tab 上的区间涨跌预览）；SW 侧 history 结果 5min 缓存（涉及缓存失效策略，建议单独评估）；FundList 虚拟滚动（持仓规模小，收益低）。
> 验证：`pnpm -r typecheck` 全绿、`cargo check`（主 crate）通过、`pnpm --filter @fund01/chrome build` 成功（v1.2.2）。

---

## 🔴 内存占用（按影响排序）

### 1. `packages/services/src/fund.ts` 模块级缓存无界增长
- `HOLDINGS_CACHE`（L875）：每只基金的前十大重仓股，TTL 1h，**只惰性过期、从不主动清理**。自选/持仓越多 Map 越大。
- `CALC_GSZZL_CACHE`（L956）：TTL 5min，同样只增不减。
- 缓解因素：MV3 SW 休眠会重启清空，但盘中 alarm 每 30-60s 唤醒一次，SW 可长期活跃，缓存会持续累积。
- **建议**：写入时顺手淘汰过期项（`for (const [k, v] of cache) if (Date.now() >= v.expiresAt) cache.delete(k)`），或加条数上限（LRU）。

### 2. `apps/tauri/src-tauri/src/menubar.rs` 点击监听器泄漏
- `CLICK_LISTENED` 全局 HashSet（L24）：实例销毁时（`rebuild_menubar` 的 stale 分支 L188-195）**只 `remove` 实例、不清理监听器**，`app_listener.listen(...)` 创建的 listener 永久存活，闭包持有 `AppHandle` 引用。
- 影响：id 空间有限（overview + 6 组 + ungrouped）实际泄漏量小，但属于明确的资源泄漏，且同 id 实例重建后不会重新监听（功能靠旧 listener 兜着，行为隐晦）。
- **建议**：`ensure_click_listener` 返回 unlisten 句柄并存入静态表，销毁实例时一并 `unlisten` + 从 `CLICK_LISTENED` 移除。

### 3. `packages/ui/src/components/FundTrendChart.tsx` 全区间预取 + `since` 两万点
- 打开弹窗即 `Promise.allSettled(['3m','1y','3y'])`（L108），切「成立以来」再拉 `since`。
- `getFundHistory('since')` 后端一次拉 **40 页 × 500 = 2 万行**（`fund.ts` L564），响应 ~1MB+，经 `sendResponse` 序列化给 popup；`byRange` state 同时驻留 4 组数据 ≈ 2.2 万点，echarts canvas 渲染明显掉帧。
- **建议**：a) 后端对 since/3y 降采样（如按周/月抽样，上限 2000 点）；b) 前端改为按 tab 点击懒加载，不做全区间预取；c) SW 侧给 history 结果加 5min 缓存，避免每次开关弹窗重复拉。

### 4. `apps/chrome/src/ports/chromeEventPort.ts` 每次刷新全量读缓存
- `onQuoteUpdate`（L20-39）：每次 `cache-time` 变化（盘中 60s 一次）都 `chrome.storage.local.get([6 个 key])` **全量读回并反序列化**全部缓存对象。
- **建议**：`storage.onChanged` 自带 `changes` 增量，可只读变化的 key（`changes` 的 newValue 直接可用，不用再 get）。

### 5. `apps/chrome/src/ports/chromeConfigPort.ts` 空 listener（L40-48）
- `onChanged` 注册了一个什么都不做的 `storage.onChanged` listener，与 EventPort 的监听并存，每次 storage 变更多跑一个空函数。
- **建议**：直接删掉这段空实现（该 Port 的同步走本地 listeners + storage 事件在 EventPort 已覆盖）。

### 6. `apps/tauri/src-tauri/src/refresh.rs` / `menubar.rs` 每轮全量 clone config
- `start_refresh_loop` 每 60s `config.read().clone()`（L22），`update_menubar` 也 clone（L234）。config 通常 <100KB，可接受；若持仓很多可改为只 clone 需要的字段（`holding_groups` / `gold` 等）。

---

## 🟡 安全性

### 1. `packages/services/src/http.ts` `credentials: 'include'`（L56 / L112）
- 对东财/新浪/腾讯等**第三方域名**显式携带用户 cookie。若用户浏览器有这些站点的登录态，会被一并发出。行情接口不需要 cookie。
- **建议**：非 fund123 的请求改 `credentials: 'omit'`（fund123 的 CSRF 流程依赖会话 cookie，保持 include 或先验证 omit 是否可行）。

### 2. `apps/chrome/src/background/index.ts` `onMessage` 无来源校验（L321）
- 任何扩展上下文（含被 XSS 攻陷的 popup/options）都能触发 REFRESH / FETCH_* 网络请求。MV3 下外部网页无法直接调用，风险低，但可低成本加固。
- **建议**：回调开头校验 `sender.url` / `sender.id` 属于本扩展，否则 return。

### 3. `apps/chrome/manifest.json` 未显式声明 CSP
- MV3 默认 `script-src 'self'` 已较安全，但显式写出 CSP（`script-src 'self'; object-src 'none'`）可防止未来引入内联脚本/远程脚本时被静默放宽。

### 4. 合规风险提示（非 bug）
- 全局伪装桌面/移动 UA 请求东财/新浪/fund123 未公开接口（`http.ts` UA、`fund.ts` `X-API-Key: 'foobar'` 硬编码）。若对方加校验或追责会失效，属灰产接口逆向的固有风险，暂不建议改，但要有心理预期。

### 5. `apps/tauri/src-tauri/src/http.rs` reqwest 无重定向限制
- 默认允许重定向（10 次），若域名被劫持可跳转任意站。可 `.redirect(reqwest::redirect::Policy::limited(3))` + 仅信任白名单 host。

### 6. 配置/缓存明文存储（平台限制）
- 持仓成本、配置存 `chrome.storage.local` / localStorage 明文；这是 Chrome 扩展与 Tauri store 的平台默认，非本项目缺陷。若在意可后续用 WebCrypto 加密，优先级低。

---

## 💭 性能 / 健壮性（可选优化）

- `fund.ts` `fetchStockPctChanges`（L896）每次调用都请求 push2 ulist.np，空窗期每基金每 5min 缓存窗口内可多次触发；可加 30s 级缓存。
- `FundList` 全量渲染所有持仓行（popup 固定 600px 高，可见仅 ~8 行）；持仓 >50 时可考虑窗口化，当前规模可不做。
- `runQuotesConcurrent` 并发 4 + 每基金最多 4-6 个请求（searchFund/matiaria/intraday/navHistory/sectors），交易时段 60s 一轮；若用户频繁手动刷新会重复拉取，可考虑加 30s 级 quote 去重缓存。

---

## ✅ 做得好的地方（保持）

- 全库无 `innerHTML` / `dangerouslySetInnerHTML` / `eval` / `new Function` —— 无 XSS 入口（React 默认转义 + tooltip 字符串拼接虽含 HTML 但数据源自受控接口且不含用户输入注入路径）。
- `httpGet` 用 `new URL` + `searchParams.set` 拼参，自动编码，无 URL 注入。
- 所有外部数值解析均过 `Number.isFinite` 防护；`parseFundMNFInfoItem` 的三种口径注释清晰。
- 定时器清理到位：`http.ts` `finally clearTimeout`；`FundTrendChart` 每个 effect 都有 `cancelled` 标志防 setState 泄漏；`window.rs` `cancel_destroy` 正确 abort 旧 timer。
- `Rust refresh_all` 用 `prev.as_ref().and_then(clone)` 保留失败源的旧数据，不丢缓存。
- 熔断器（circuit）、CSRF 重试、host fallback、错误日志（含 url/status/stack）设计成熟。

---

## 建议优先级

| 优先级 | 事项 | 位置 | 预估改动 |
|---|---|---|---|
| P1 | 缓存无界增长（淘汰过期项/上限） | `fund.ts` HOLDINGS_CACHE/CALC_GSZZL_CACHE | 小 |
| P1 | menubar 监听器泄漏 | `menubar.rs` ensure_click_listener | 小 |
| P1 | since/3y 降采样 + tab 懒加载 | `fund.ts` / `FundTrendChart.tsx` | 中 |
| P2 | credentials: omit（非 fund123） | `http.ts` | 小 |
| P2 | onMessage sender 校验 + 显式 CSP | `background/index.ts` / `manifest.json` | 小 |
| P2 | EventPort 增量读缓存 | `chromeEventPort.ts` | 小 |
| P3 | 其余 nit（空 listener、重定向限制、quote 去重缓存等） | 各处 | 小 |
