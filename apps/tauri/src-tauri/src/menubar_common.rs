//! menubar/taskband 共用纯逻辑（无插件依赖，macOS 与 Windows 共享）。
//!
//! 从 menubar.rs 抽出：实例期望集合计算、分组涨跌口径、文本/颜色格式化、实例 id 编解码。
//! 唯一消费者是 menubar.rs（macOS）与 taskband.rs（Windows）两套插件编排层。
//!
//! ⚠️ 口径铁律：`menubar_all_hidden` 与前端 `isMenubarEmpty`（packages/ui/src/lib/fundOps.ts）
//! 保持 1:1 一致；分组涨跌/收益额口径与 popup 分组聚合一致（份额取最新 config 为权威）。

use std::collections::HashMap;

use crate::calc::round2;
use crate::model::{AppConfig, FundQuoteRow, HoldingsSummary, QuoteUpdate};

pub const INSTANCE_OVERVIEW: &str = "menubar-overview";

/// 「历史」实例 id（**可选实例**：由 `menubarHistoryEnabled` 决定存在与否）。
/// ⚠️ 与总览「恒在、只翻 visible」的策略不同——历史项的开关状态本身持久化在设置里，
/// 关闭即从 `desired_instances` 消失并被 `sync_instances` 真正销毁，无需靠实例存活保留位置。
pub const INSTANCE_HISTORY: &str = "menubar-history";

/// 历史实例「快照未就绪」时的下行占位文本（首次刷新前还没有 summary）
pub const BOTTOM_PLACEHOLDER: &str = "-";
/// 隐私模式下「当前持仓额」档的遮罩文本（金额档无百分比等价物，直接打码；与 popup 口径一致）
pub const BOTTOM_MASKED: &str = "****";

pub const COLOR_RISE_DEFAULT: &str = "#FF4F44"; // 涨/红（默认，可配置 menubarRiseColor）
pub const COLOR_FALL_DEFAULT: &str = "#34C759"; // 跌/绿（默认，可配置 menubarFallColor）
pub const COLOR_FLAT_DEFAULT: &str = "#8e8e93"; // 平/灰（默认，可配置 menubarFlatColor）
pub const COLOR_TOP_DEFAULT: &str = "#ffffff"; // 上行固定色默认（可配置 menubarTopColor）

pub(crate) fn color_for(pct: f64, rise: &str, fall: &str, flat: &str) -> String {
    if pct > 0.0 {
        rise.to_string()
    } else if pct < 0.0 {
        fall.to_string()
    } else {
        flat.to_string()
    }
}

pub(crate) fn format_pct(pct: f64) -> String {
    if !pct.is_finite() {
        return "0.00%".to_string();
    }
    if pct.abs() >= 100.0 {
        format!("{:+.0}%", pct)
    } else {
        format!("{:+.2}%", pct)
    }
}

/// 收益额显示（菜单栏专用，不受长度限制；与 format.rs 的 badge 简写规则不同）。
/// - 绝对值 ≥ 10 万：w（万）缩写，最多 1 位小数（整数则不带小数）；
/// - 绝对值 < 10 万：完整整数显示，无缩写、无小数点。
/// 均带方向符号；符号由调用方颜色 + 前缀表达。
pub(crate) fn format_amount(v: f64) -> String {
    if !v.is_finite() {
        return "+0".to_string();
    }
    let sign = if v < 0.0 { "-" } else { "+" };
    let abs = v.abs();
    if abs >= 1e5 {
        let n = abs / 1e4;
        let is_int = (n - n.round()).abs() < 1e-9;
        let s = if is_int {
            format!("{n:.0}")
        } else {
            format!("{n:.1}")
        };
        format!("{sign}{s}w")
    } else {
        format!("{sign}{}", abs.round())
    }
}

/// 持仓额显示（菜单栏/任务栏专用**第 5 套**格式化，与既有四套互斥隔离、勿混用：
/// `menubar_common::format_amount`=带方向符号的收益额、`format.rs::format_short_amount`=badge 简写、
/// `format.ts`=Dock badge、`packages/core/format.ts`=第 4 套）。
///
/// 规则：**无 +/- 方向前缀**（持仓额没有涨跌语义）；绝对值 ≥ 10 万用 `w`（万）缩写、
/// 最多 1 位小数（整数不带小数）；否则四舍五入到整数。市值恒非负，负数按绝对值兜底。
pub(crate) fn format_holding_amount(v: f64) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let abs = v.abs();
    if abs >= 1e5 {
        let n = abs / 1e4;
        let is_int = (n - n.round()).abs() < 1e-9;
        if is_int {
            format!("{n:.0}w")
        } else {
            format!("{n:.1}w")
        }
    } else {
        format!("{}", abs.round())
    }
}

/// 行情行索引：code → quote 行（分组归属与份额以最新 config 为准，此处只取行情数值）
type QuoteRows<'a> = HashMap<&'a str, &'a FundQuoteRow>;

/// 「历史」实例**某一行**的内容档（对应设置 `menubarHistoryTopMode` / `menubarHistoryMode`）。
/// 上下两行共用这一组档位（默认 上行=Label、下行=CumAmount），故档位与行无关，
/// 只是「第二行不允许 Label」（`parse_bottom` 会把 label 判非法回落）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryMode {
    /// 名称文字（第一行专属档；`Label` 档取 `InstanceSpec.top`）
    Label,
    /// 历史收益涨跌幅（累计收益率）
    CumPercent,
    /// 历史收益额
    CumAmount,
    /// 当前持仓额
    HoldingAmount,
}

impl HistoryMode {
    /// 解析**第一行**档位：接受四档（含 Label=名称文字），非法/缺省回落 Label
    /// （与 TS `normalizeMenubarHistoryTopMode` 口径一致）
    pub fn parse_top(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("cumPercent") => Self::CumPercent,
            Some("cumAmount") => Self::CumAmount,
            Some("holdingAmount") => Self::HoldingAmount,
            _ => Self::Label,
        }
    }

    /// 解析**第二行**档位：只接受三档数值，非法/缺省回落 CumAmount
    /// （与 TS `normalizeMenubarHistoryMode` 口径一致）。
    /// ⚠️ `label` 是第一行专属档，此处判非法并回落 —— 第二行恒为数值。
    pub fn parse_bottom(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("cumPercent") => Self::CumPercent,
            Some("holdingAmount") => Self::HoldingAmount,
            _ => Self::CumAmount,
        }
    }
}

/// 「历史」实例数值档的**取数口径**（对应设置 `menubarHistoryValuation`）。
///
/// 历史实例的三个数值档都由「当前市值 − 已录入成本」推出，本枚举决定**市值**取哪一档，
/// 换算见 `history_values`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryValuation {
    /// 含今日：市值用「份额 × 当前净值」（盘中取估值净值、披露后取今日确认净值），
    /// 三档数字随行情实时跳动 —— 历史收益额因此**包含今天的盈亏**
    Latest,
    /// 只用已公布净值：盘中即昨日确认净值，当日净值披露后切成今日确认净值，
    /// 披露前数字保持稳定（与 popup 顶部「持仓金额」同口径）
    Confirmed,
}

impl HistoryValuation {
    /// 解析口径设置：只接受 `latest` / `confirmed`，非法/缺省回落 `Latest`
    /// （与 TS `normalizeMenubarHistoryValuation` 口径一致）
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("confirmed") => Self::Confirmed,
            _ => Self::Latest,
        }
    }
}

/// 实例的数值语义来源（决定「哪一行的内容由什么决定」）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BottomKind {
    /// 当日收益（总览 / 各分组 / 未分组）：上行恒为名称文字，下行受 `menubarShowAmount`
    /// 切换百分比↔金额，恒有涨跌语义
    DayPnl,
    /// 历史累计（可选实例）：**上下两行各自**受 `menubarHistoryTopMode` / `menubarHistoryMode`
    /// 切换档位（四档/三档），行内容见 `history_row_display`
    History,
}

/// 一行的渲染结果：文本 + 配色依据。
pub struct RowDisplay {
    pub text: String,
    /// `Some(v)` → 该行有涨跌语义，**未自定义颜色**时按 v 取涨跌色（正=涨 / 负=跌 / 零=平）；
    /// `None` → 无涨跌语义（名称文字 / 持仓额 / 占位符 / 打码），未自定义颜色时走该行的颜色链
    /// （上行=分组自定义色→全局上行色→系统色；下行=跟随上行已解析色）
    pub signed: Option<f64>,
}

impl RowDisplay {
    /// 纯文字行（无涨跌语义）：DayPnl 实例的上行（总览 / 分组名 / 未分组）用
    pub(crate) fn text(text: String) -> Self {
        Self { text, signed: None }
    }
}

fn quote_rows(quote: Option<&QuoteUpdate>) -> QuoteRows<'_> {
    quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.list.iter().map(|r| (r.fund.code.as_str(), r)).collect())
        .unwrap_or_default()
}

/// 分组涨跌（%）：Σ(组内份额分摊的 pnl) / Σ(组内份额 × 昨净值)
/// 份额取最新 config.holdings（权威），行情（pnl/昨净值）取 quote 快照，缺失按 0。
/// 不用 quote 行内的 allocations：那是「上次刷新时」的 config 快照，
/// 重命名/调整分组后两者会错位，导致实例集合误判、数值显示旧份额。
/// 收益用「每份收益 × 最新份额」分摊：修改持仓后即使行情未刷新，数值也立即贴合新份额。
/// 当日收益为空的成员（QDII 盘中 pnl=None）分子分母同步排除，避免 0 占位稀释（§六）。
fn group_percent(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    let mut bod = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let Some(row) = rows.get(fund.code.as_str()).copied() else {
            continue;
        };
        let Some(row_pnl) = row.pnl else { continue };
        let total = row.fund.total_shares();
        if total <= 0.0 {
            continue;
        }
        pnl += (row_pnl / total) * sh_g;
        bod += sh_g * row.prev_net_value.unwrap_or(0.0);
    }
    if bod > 0.0 {
        pnl / bod * 100.0
    } else {
        0.0
    }
}

/// 分组收益额：Σ(组内份额分摊的 pnl)（份额取最新 config，每份收益口径同上）
/// 当日收益为空的成员（QDII 盘中 pnl=None）不参与求和（§六，与 UI 分组口径一致）。
fn group_pnl(config: &AppConfig, rows: &QuoteRows<'_>, group: &str) -> f64 {
    let mut pnl = 0.0f64;
    for fund in config.holdings.values() {
        let sh_g = fund.allocations.get(group).copied().unwrap_or(0.0);
        if sh_g <= 0.0 {
            continue;
        }
        let Some(row) = rows.get(fund.code.as_str()).copied() else {
            continue;
        };
        let Some(row_pnl) = row.pnl else { continue };
        let total = row.fund.total_shares();
        if total > 0.0 {
            pnl += (row_pnl / total) * sh_g;
        }
    }
    pnl
}

/// 是否存在未分组持仓：以最新 config 的份额为权威（同 group_percent 的理由，
/// 避免重命名/调整分组后依赖过期行情快照误判出多余的 ungrouped 实例）。
fn has_ungrouped(config: &AppConfig, groups: &[String]) -> bool {
    config.holdings.values().any(|fund| {
        fund.allocations
            .iter()
            .any(|(g, sh)| (*sh > 0.0) && !groups.iter().any(|known| known == g))
    })
}

/// menubar/taskbar 是否全空（所有实例都被隐藏，用户把每个分组都移出了显示）。
///
/// 判定（只依赖 config，与行情无关）：
/// 0. 「历史」实例开着（`menubarHistoryEnabled`）→ 菜单栏必然非空；
/// 1. 总览（`__overview__`）被隐藏——设置页无法关闭总览，只有 macOS ⌘-拖出会写入该标记
///    （Windows 无拖出通道，本判定恒 false，启动恢复逻辑在 Windows 上自然不触发）；
/// 2. 每个持仓分组都在 `menubar_hidden_groups`；
/// 3. 存在未分组持仓时，未分组实例（`""`）也在隐藏列表。
///
/// ⚠️ 判定口径与前端 `isMenubarEmpty`（packages/ui/src/lib/fundOps.ts）保持一致（两端 1:1 铁律）。
/// 调用场景：⌘-拖出最后一个实例后自动弹 popup-tab；窗口 Destroyed 后全空即退出；启动时全空恢复默认。
pub fn menubar_all_hidden(config: &AppConfig) -> bool {
    // 0. 历史项开着 → 菜单栏里还有东西，不算全空
    if config.settings.menubar_history_enabled.unwrap_or(false) {
        return false;
    }
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    // 1. 总览必须被隐藏
    if !hidden
        .iter()
        .any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY)
    {
        return false;
    }
    // 2. 每个持仓分组必须被隐藏
    for g in &groups {
        if !hidden.iter().any(|h| h == g) {
            return false;
        }
    }
    // 3. 存在未分组持仓时，未分组实例（''）必须也在隐藏列表
    if has_ungrouped(config, &groups) && !hidden.iter().any(|h| h.is_empty()) {
        return false;
    }
    true
}

/// 分组名 → 实例 id 后缀：按字节 hex 编码（每字节两位小写 hex）。
/// 实例 id 只依赖分组名（与 holding_groups 下标无关）→ 分组排序变化不重建实例，
/// macOS 原生「按住 ⌘ 拖拽」调整的菜单栏顺序得以保留。
/// ⚠️ 不能用 percent-encoding：tauri 事件名（`multiline-menubar://{id}//click`）只允许
/// 字母数字 + `-`/`/`/`:`/`_`，`%` 非法（IllegalEventName panic）；hex 字符全部合法且无歧义。
pub(crate) fn encode_group_id(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 2);
    for b in name.as_bytes() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub(crate) fn decode_group_id(enc: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(enc.len() / 2);
    let mut chars = enc.bytes();
    while let (Some(h), Some(l)) = (chars.next(), chars.next()) {
        if let (Some(h), Some(l)) = (hex_val(h), hex_val(l)) {
            out.push(h * 16 + l);
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// 一个菜单栏/任务栏实例的期望状态。
///
/// `visible` 与「实例是否在列表里」是**两个独立维度**：
/// - 在列表里 + `visible=true`  → 实例存在且显示
/// - 在列表里 + `visible=false` → 实例存在但隐藏（slot/位置保留，随时原位复活）
/// - 不在列表里                 → 实例不该存在，`sync_instances` 才会真正 `remove` 销毁
pub struct InstanceSpec {
    pub id: String,
    /// 顶行文字（历史 / 总览 / 分组名 / 未分组）
    pub top: String,
    /// 下行数值语义（当日收益 / 历史累计）
    pub kind: BottomKind,
    /// 当日收益涨跌百分比（`kind=DayPnl` 时用）
    pub pct: f64,
    /// 当日收益额（`kind=DayPnl` 时用）
    pub amount: f64,
    /// 历史收益额（`kind=History`；`None` = 未录入成本，算不出累计收益）
    pub cum_amount: Option<f64>,
    /// 历史收益涨跌幅（`kind=History`；`None` 同上）
    pub cum_pct: Option<f64>,
    /// 当前持仓额（`kind=History`；`None` = 行情快照尚未就绪）。
    /// 口径受 `menubarHistoryValuation` 控制（见 `history_values`）：
    /// latest = `summary.total_amount_latest`（全部持仓，含今日）；confirmed = `summary.total_amount`
    /// （全部持仓，已公布净值，与 popup 顶部「持仓金额」一致）。也是收益档无成本时的回退值
    pub holding_amount: Option<f64>,
    /// 是否显示（false = 隐藏但保留实例）
    pub visible: bool,
}

impl InstanceSpec {
    /// 构造「当日收益」类实例（总览 / 分组 / 未分组）
    fn day_pnl(id: String, top: String, pct: f64, amount: f64, visible: bool) -> Self {
        Self {
            id,
            top,
            kind: BottomKind::DayPnl,
            pct,
            amount,
            cum_amount: None,
            cum_pct: None,
            holding_amount: None,
            visible,
        }
    }
}

/// 按 `menubarHistoryValuation` 口径算出「历史」实例的三个数值档：
/// `(历史收益额, 历史收益涨跌幅, 当前持仓额)`。
///
/// 三者共用同一个「市值」基准，本函数是**唯一**决定该基准取哪一档的地方：
/// - `Latest`    ：收益两档直接复用 summary 的 `total_cum_pnl(_percent)`
///                 （与「含今日市值」同口径，不再二次舍入，保证与升级前数值完全一致）；
/// - `Confirmed` ：收益两档 = 「已录成本部分的已公布净值市值 − 总成本」现场推算。
///
/// ⚠️ 收益只统计**已录入成本**的持仓（与 popup 口径一致），故「已确认」口径下必须用
/// `total_costed_amount` 而不是 `total_amount`——否则未录成本持仓的市值会被误算成收益。
/// 「当前持仓额」反过来要展示**全部**持仓市值（用户要看的是总市值），故用 `total_amount`
/// / `total_amount_latest`。
///
/// 未录入成本（`total_cost` ≤ 0，Rust 侧为 `Some(0.0)`）→ 收益两档均为 `None`
/// （渲染层回落显示持仓额）；快照未就绪（`summary` 为 `None`）→ 三个值全 `None`（显示占位符）。
pub fn history_values(
    summary: Option<&HoldingsSummary>,
    valuation: HistoryValuation,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(s) = summary else {
        return (None, None, None);
    };
    let cost = s.total_cost.filter(|c| *c > 0.0);
    match valuation {
        HistoryValuation::Latest => (
            s.total_cum_pnl,
            s.total_cum_pnl_percent,
            Some(s.total_amount_latest),
        ),
        HistoryValuation::Confirmed => match cost {
            Some(c) => {
                let profit = s.total_costed_amount - c;
                (
                    Some(round2(profit)),
                    Some(round2(profit / c * 100.0)),
                    Some(s.total_amount),
                )
            }
            None => (None, None, Some(s.total_amount)),
        },
    }
}

/// 计算期望实例列表。
///
/// 返回**全集**（含设置页里被隐藏的分组），隐藏只体现为 `visible=false`——这样实例永远不被
/// 销毁，开关分组不会丢失位置。只有「分组被删除/重命名」「未分组持仓清空」才会让
/// 对应 id 从列表里消失，进而被 `sync_instances` 真正 remove。
///
/// ⚠️ 例外：**「历史」实例**（`menubarHistoryEnabled`）关闭时不在列表里，会被真正销毁——
/// 它的显隐状态持久化在设置项里，不需要靠实例存活保留位置（详见 INSTANCE_HISTORY 注释）。
///
/// 实例集合（分组归属/未分组判定）与份额一律以最新 config 为权威，行情仅取 quote。
/// 顺序（同时是 Windows 任务栏 set_order 的依据，也是 macOS 首次创建的顺序）：
/// 历史 → 总览 → 各分组（holdingGroups 顺序）→ 未分组。
pub fn desired_instances(config: &AppConfig, quote: Option<&QuoteUpdate>) -> Vec<InstanceSpec> {
    let groups = config.settings.holding_groups.clone().unwrap_or_default();
    let hidden = config
        .settings
        .menubar_hidden_groups
        .clone()
        .unwrap_or_default();
    let rows = quote_rows(quote);

    let mut out: Vec<InstanceSpec> = Vec::new();
    let overview = quote
        .and_then(|q| q.holdings.as_ref())
        .map(|h| h.summary.clone());

    // 「历史」实例（可选，排在最前）：整体组合的累计表现。
    // 上下两行的取数与档位见 history_row_display；三档数值统一由 history_values 按
    // `menubarHistoryValuation` 口径产出（latest=含今日市值，confirmed=只用已公布净值）。
    // 快照未就绪（quote=None）时三值均为 None → 该行显示占位符。
    if config.settings.menubar_history_enabled.unwrap_or(false) {
        let valuation =
            HistoryValuation::parse(config.settings.menubar_history_valuation.as_deref());
        let (cum_amount, cum_pct, holding_amount) = history_values(overview.as_ref(), valuation);
        out.push(InstanceSpec {
            id: INSTANCE_HISTORY.to_string(),
            top: crate::portfolio::normalize_menubar_history_label(
                config.settings.menubar_history_label.as_deref(),
            ),
            kind: BottomKind::History,
            pct: 0.0,
            amount: 0.0,
            cum_amount,
            cum_pct,
            holding_amount,
            visible: true,
        });
    }

    // 总览恒在（实例不销毁）；默认恒显示，但被用户 ⌘-拖出（写入 __overview__ 隐藏标记）后
    // visible=false——设置界面据此解锁总览为可重新开启，开启后恢复恒显。
    let overview_hidden = hidden
        .iter()
        .any(|h| h == crate::portfolio::MENUBAR_OVERVIEW_KEY);
    out.push(InstanceSpec::day_pnl(
        INSTANCE_OVERVIEW.to_string(),
        "总览".to_string(),
        overview.as_ref().map(|s| s.total_pnl_percent).unwrap_or(0.0),
        overview.as_ref().map(|s| s.total_pnl).unwrap_or(0.0),
        !overview_hidden,
    ));

    // 每个分组一个实例：隐藏的分组**照样进列表**，只是 visible=false。
    // 实例 id 基于分组名（稳定）：持仓分组拖拽排序只改 holding_groups 顺序、不改 id，
    // 实例既不重建也不销毁 → 菜单栏位置（含 mac 原生 ⌘-拖拽结果）完整保留。
    for g in &groups {
        out.push(InstanceSpec::day_pnl(
            format!("menubar-group-{}", encode_group_id(g)),
            g.clone(),
            group_percent(config, &rows, g),
            group_pnl(config, &rows, g),
            !hidden.iter().any(|h| h == g),
        ));
    }
    // 未分组实例只在「确实存在未分组持仓」时才存在；隐藏同样只翻 visible
    if has_ungrouped(config, &groups) {
        out.push(InstanceSpec::day_pnl(
            "menubar-ungrouped".to_string(),
            "未分组".to_string(),
            group_percent(config, &rows, ""),
            group_pnl(config, &rows, ""),
            !hidden.iter().any(|h| h.is_empty()),
        ));
    }
    out
}

/// 点击实例 id → popup 分组 tab id（与前端 GroupTabs 的 tab id 对齐）：
/// 历史 / 总览 → 'all'；未分组 → '__ungrouped__'；menubar-group-{enc} → 解码出的分组名。
pub(crate) fn popup_tab_for(id: &str) -> Option<String> {
    if id == INSTANCE_OVERVIEW || id == INSTANCE_HISTORY {
        return Some("all".to_string());
    }
    if id == "menubar-ungrouped" {
        return Some("__ungrouped__".to_string());
    }
    id.strip_prefix("menubar-group-")
        .map(decode_group_id)
        .filter(|name| !name.is_empty())
}

/// 实例 id → 人类可读标签（历史 / 总览 / 未分组 / 分组名），用于日志排查。
/// ⚠️ 「历史」恒返回固定名「历史」而非用户自定义标题：该标签用于日志与右键菜单文案，
/// 固定名避免用户改名后日志/菜单项文案漂移难对。
pub(crate) fn instance_label(id: &str) -> String {
    if id == INSTANCE_OVERVIEW {
        "总览".to_string()
    } else if id == INSTANCE_HISTORY {
        "历史".to_string()
    } else if id == "menubar-ungrouped" {
        "未分组".to_string()
    } else {
        id.strip_prefix("menubar-group-")
            .map(decode_group_id)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.to_string())
    }
}

/// 渲染「历史」实例的**某一行**（macOS 菜单栏与 Windows 任务栏唯一共用口径）。
/// 上下两行共用本函数，只是传入各自的档位（上行 `parse_top` / 下行 `parse_bottom`）。
///
/// `privacy` = 隐私模式（金额类一律降级/打码）。
///
/// 规则表：
/// | 档位 | 有成本 | 结果 |
/// | --- | --- | --- |
/// | 名称文字(label) | — | `spec.top`（本实例名称），无涨跌语义 |
/// | 历史收益涨跌幅 | 是 | `format_pct(cum_pct)`，有涨跌语义 |
/// | 历史收益额 | 是 | `format_amount(cum_amount)`，有涨跌语义 |
/// | 任意收益档 | 否（未录入成本） | **回退**当前持仓额，无涨跌语义 |
/// | 当前持仓额 | — | `format_holding_amount(holding)`，无涨跌语义 |
///
/// 「有涨跌语义」= `RowDisplay.signed` 为 `Some` → 该行未自定义颜色时取涨跌色（正红负绿）；
/// 无涨跌语义的行未自定义颜色时走该行颜色链（详见 `RowDisplay::signed`）。
///
/// 隐私模式：收益额档降级为涨跌幅档（只暴露百分比）；持仓额档（含无成本回退）无百分比
/// 等价物 → 打码 `****`。快照未就绪（holding_amount=None）→ 占位符 `-`。
pub(crate) fn history_row_display(
    spec: &InstanceSpec,
    mode: HistoryMode,
    privacy: bool,
) -> RowDisplay {
    // 隐私模式：只暴露百分比，金额档降级为收益率档；持仓额档留在 holding 分支里打码
    let mode = if privacy && mode == HistoryMode::CumAmount {
        HistoryMode::CumPercent
    } else {
        mode
    };
    match mode {
        HistoryMode::Label => RowDisplay::text(spec.top.clone()),
        HistoryMode::HoldingAmount => holding_display(spec.holding_amount, privacy),
        HistoryMode::CumAmount => match spec.cum_amount {
            Some(v) => RowDisplay {
                text: format_amount(v),
                signed: Some(v),
            },
            None => holding_display(spec.holding_amount, privacy),
        },
        HistoryMode::CumPercent => match spec.cum_pct {
            Some(v) => RowDisplay {
                text: format_pct(v),
                signed: Some(v),
            },
            None => holding_display(spec.holding_amount, privacy),
        },
    }
}

/// 渲染「当日收益」实例的下行（总览 / 各分组 / 未分组）：
/// 受 `menubarShowAmount` 切换百分比↔金额（隐私模式下由调用方强制百分比），恒有涨跌语义。
pub(crate) fn day_pnl_display(spec: &InstanceSpec, show_amount: bool) -> RowDisplay {
    if show_amount {
        RowDisplay {
            text: format_amount(spec.amount),
            signed: Some(spec.amount),
        }
    } else {
        RowDisplay {
            text: format_pct(spec.pct),
            signed: Some(spec.pct),
        }
    }
}

/// 实例两行内容的统一入口（macOS 菜单栏与 Windows 任务栏共用，`kind` 分派在此收口）：
/// - `DayPnl`（总览 / 分组 / 未分组）：上行恒为名称文字，下行受 `show_amount` 切换；
/// - `History`（「历史」实例）：上下两行各自按 `top_mode` / `bottom_mode` 取内容。
///
/// 档位解析（`HistoryMode::parse_top` / `parse_bottom`）由调用方完成，
/// 保证两端用同一份解析口径，而调用方不重复实现分派。
pub(crate) fn rows_of(
    spec: &InstanceSpec,
    show_amount: bool,
    privacy: bool,
    top_mode: HistoryMode,
    bottom_mode: HistoryMode,
) -> (RowDisplay, RowDisplay) {
    match spec.kind {
        BottomKind::DayPnl => (
            RowDisplay::text(spec.top.clone()),
            day_pnl_display(spec, show_amount),
        ),
        BottomKind::History => (
            history_row_display(spec, top_mode, privacy),
            history_row_display(spec, bottom_mode, privacy),
        ),
    }
}

/// 持仓额行的展示：无方向符号的金额、**无涨跌语义**（`signed=None`）；
/// 隐私模式打码，快照未就绪显示占位符。
fn holding_display(holding_amount: Option<f64>, privacy: bool) -> RowDisplay {
    if privacy {
        return RowDisplay {
            text: BOTTOM_MASKED.to_string(),
            signed: None,
        };
    }
    match holding_amount {
        Some(v) => RowDisplay {
            text: format_holding_amount(v),
            signed: None,
        },
        None => RowDisplay {
            text: BOTTOM_PLACEHOLDER.to_string(),
            signed: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_below_100k_full_integer() {
        assert_eq!(format_amount(0.0), "+0");
        assert_eq!(format_amount(856.0), "+856");
        assert_eq!(format_amount(9999.0), "+9999");
        assert_eq!(format_amount(12345.0), "+12345");
        assert_eq!(format_amount(99999.4), "+99999");
        assert_eq!(format_amount(-12345.0), "-12345");
        // 四舍五入到整数，无小数点
        assert_eq!(format_amount(99999.6), "+100000");
    }

    #[test]
    fn amount_from_100k_uses_w() {
        assert_eq!(format_amount(100000.0), "+10w");
        assert_eq!(format_amount(100000.4), "+10.0w");
        assert_eq!(format_amount(123456.0), "+12.3w");
        assert_eq!(format_amount(1000000.0), "+100w");
        // 超过千万不再用 kw，统一 w
        assert_eq!(format_amount(12345678.0), "+1234.6w");
        assert_eq!(format_amount(-123456.0), "-12.3w");
        // 整数缩放后无小数
        assert_eq!(format_amount(150000.0), "+15w");
    }

    #[test]
    fn amount_non_finite() {
        assert_eq!(format_amount(f64::NAN), "+0");
        assert_eq!(format_amount(f64::INFINITY), "+0");
    }

    #[test]
    fn pct_unchanged() {
        assert_eq!(format_pct(12.345), "+12.35%");
        assert_eq!(format_pct(-0.5), "-0.50%");
        assert_eq!(format_pct(123.4), "+123%");
    }

    /// 持仓额（第 5 套格式）：无方向符号；≥10 万用 w，否则整数
    #[test]
    fn holding_amount_has_no_sign_and_uses_w_above_100k() {
        assert_eq!(format_holding_amount(0.0), "0");
        assert_eq!(format_holding_amount(12345.0), "12345");
        assert_eq!(format_holding_amount(99999.6), "100000");
        assert_eq!(format_holding_amount(100000.0), "10w");
        assert_eq!(format_holding_amount(123456.0), "12.3w");
        assert_eq!(format_holding_amount(150000.0), "15w");
        assert_eq!(format_holding_amount(12345678.0), "1234.6w");
        // 市值恒非负；负数/非法值兜底
        assert_eq!(format_holding_amount(-12345.0), "12345");
        assert_eq!(format_holding_amount(f64::NAN), "0");
    }

    /// 「历史」实例构造器（测试辅助）
    fn history_spec(
        cum_amount: Option<f64>,
        cum_pct: Option<f64>,
        holding_amount: Option<f64>,
    ) -> InstanceSpec {
        InstanceSpec {
            id: INSTANCE_HISTORY.to_string(),
            top: "历史".to_string(),
            kind: BottomKind::History,
            pct: 0.0,
            amount: 0.0,
            cum_amount,
            cum_pct,
            holding_amount,
            visible: true,
        }
    }

    /// 总览 summary 构造器（测试辅助）：只暴露与口径相关的字段
    fn summary_for(
        total_amount: f64,
        total_amount_latest: f64,
        total_costed_amount: f64,
        total_cost: Option<f64>,
        total_cum_pnl: Option<f64>,
        total_cum_pnl_percent: Option<f64>,
    ) -> HoldingsSummary {
        HoldingsSummary {
            total_amount,
            total_amount_latest,
            total_costed_amount,
            bod_total: None,
            total_pnl: 0.0,
            total_pnl_percent: 0.0,
            total_cost,
            total_cum_pnl,
            total_cum_pnl_percent,
        }
    }

    /// 两口径对照：**部分持仓未录成本**时，「已确认」口径绝不能把未录成本部分的市值算成收益。
    ///
    /// 场景：A 录了成本（成本 1w、已确认市值 1w、含今日市值 1.05w）；
    ///      B 未录成本（已确认市值 1000、含今日市值 1050）。
    /// 总览：全部@已确认 11000、全部@含今日 11550、有成本部分@已确认 10000、总成本 10000。
    #[test]
    fn history_valuation_two_paths_exclude_uncosted_holdings_from_profit() {
        let s = summary_for(11000.0, 11550.0, 10000.0, Some(10000.0), Some(500.0), Some(5.0));

        // 含今日（默认）：收益额/涨跌幅直接复用 total_cum_pnl(_percent)，持仓额=全部@含今日
        let latest = history_values(Some(&s), HistoryValuation::Latest);
        assert_eq!(latest, (Some(500.0), Some(5.0), Some(11550.0)));

        // 已确认：收益 = 有成本部分@已确认 − 成本 = 10000 − 10000 = 0（B 的 1000 不得计入）
        //          持仓额 = 全部@已确认 = 11000
        let confirmed = history_values(Some(&s), HistoryValuation::Confirmed);
        assert_eq!(confirmed, (Some(0.0), Some(0.0), Some(11000.0)));
    }

    /// 「已确认」口径的收益/涨跌幅由市值现场推算（含负数与四舍五入到分）
    #[test]
    fn history_valuation_confirmed_computes_from_costed_amount() {
        // 有成本部分@已确认 9750.5、成本 10000 → 亏损 -249.5 / -2.495% → round2 = -2.5
        let s = summary_for(10750.5, 10900.0, 9750.5, Some(10000.0), Some(900.0), Some(9.0));
        assert_eq!(
            history_values(Some(&s), HistoryValuation::Confirmed),
            (Some(-249.5), Some(-2.5), Some(10750.5))
        );
    }

    /// 未录成本（total_cost = Some(0.0)，与 calc 的「未录成本」表示一致）：
    /// 收益两档算不出 → None（渲染层回落显示持仓额），持仓额仍按口径给全部市值
    #[test]
    fn history_valuation_without_cost_returns_none_profit() {
        let s = summary_for(11000.0, 11550.0, 0.0, Some(0.0), None, None);
        assert_eq!(
            history_values(Some(&s), HistoryValuation::Latest),
            (None, None, Some(11550.0))
        );
        assert_eq!(
            history_values(Some(&s), HistoryValuation::Confirmed),
            (None, None, Some(11000.0))
        );
        // total_cost 为 None 同样判为未录成本
        let s_none_cost = summary_for(11000.0, 11550.0, 0.0, None, None, None);
        assert_eq!(
            history_values(Some(&s_none_cost), HistoryValuation::Confirmed),
            (None, None, Some(11000.0))
        );
    }

    /// 快照未就绪（summary=None）→ 三值全 None（渲染层显示占位符）
    #[test]
    fn history_valuation_without_snapshot_returns_all_none() {
        for v in [HistoryValuation::Latest, HistoryValuation::Confirmed] {
            assert_eq!(history_values(None, v), (None, None, None));
        }
    }

    /// 口径解析：只认 latest/confirmed（含 trim），非法/缺省回落 latest
    #[test]
    fn history_valuation_parse_accepts_two_values() {
        assert_eq!(
            HistoryValuation::parse(Some("latest")),
            HistoryValuation::Latest
        );
        assert_eq!(
            HistoryValuation::parse(Some("confirmed")),
            HistoryValuation::Confirmed
        );
        assert_eq!(
            HistoryValuation::parse(Some(" confirmed ")),
            HistoryValuation::Confirmed
        );
        assert_eq!(HistoryValuation::parse(Some("bogus")), HistoryValuation::Latest);
        assert_eq!(HistoryValuation::parse(None), HistoryValuation::Latest);
        assert_eq!(HistoryValuation::parse(Some("")), HistoryValuation::Latest);
    }

    /// 「历史」两行共用的档位规则表：取值 + 配色依据。
    /// 有涨跌语义的档（收益两档）必须 signed=Some；名称/持仓额/回退/占位符必须 signed=None。
    #[test]
    fn history_row_display_rule_table() {
        let spec = history_spec(Some(-12345.0), Some(-12.34), Some(98765.0));
        // 第一行 Label 档：渲染本实例名称，无涨跌语义（未自定义颜色时走颜色链）
        let label = history_row_display(&spec, HistoryMode::Label, false);
        assert_eq!(label.text, "历史");
        assert_eq!(label.signed, None);
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumPercent, false).text,
            "-12.34%"
        );
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumAmount, false).text,
            "-12345"
        );
        assert_eq!(
            history_row_display(&spec, HistoryMode::HoldingAmount, false).text,
            "98765"
        );
        // 收益档有涨跌语义 → signed=Some；持仓额档无 → signed=None
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumAmount, false).signed,
            Some(-12345.0)
        );
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumPercent, false).signed,
            Some(-12.34)
        );
        assert_eq!(
            history_row_display(&spec, HistoryMode::HoldingAmount, false).signed,
            None
        );
        // 隐私模式：收益额档降级为收益率档；持仓额档打码（同样无涨跌语义）
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumAmount, true).text,
            "-12.34%"
        );
        let masked = history_row_display(&spec, HistoryMode::HoldingAmount, true);
        assert_eq!(masked.text, BOTTOM_MASKED);
        assert_eq!(masked.signed, None);
    }

    /// 上下两行档位完全独立：同一档在两行渲染出完全一致的结果（允许重复，不做去重干预）；
    /// 默认组合 = 上行 Label（名称）+ 下行 CumAmount（历史收益额）。
    #[test]
    fn history_rows_are_independent_and_may_repeat() {
        let spec = history_spec(Some(8888.0), Some(8.88), Some(66666.0));
        for mode in [
            HistoryMode::Label,
            HistoryMode::CumPercent,
            HistoryMode::CumAmount,
            HistoryMode::HoldingAmount,
        ] {
            let top = history_row_display(&spec, mode, false);
            let bottom = history_row_display(&spec, mode, false);
            assert_eq!(top.text, bottom.text, "mode={mode:?} 两行同档应同值");
            assert_eq!(top.signed, bottom.signed, "mode={mode:?}");
        }
        assert_eq!(
            history_row_display(&spec, HistoryMode::Label, false).text,
            "历史"
        );
        assert_eq!(
            history_row_display(&spec, HistoryMode::CumAmount, false).text,
            "+8888"
        );
    }

    /// 未录入成本（算不出累计收益）→ 回退显示当前持仓额
    #[test]
    fn history_falls_back_to_holding_amount_when_cost_missing() {
        let no_cost = history_spec(None, None, Some(52000.0));
        for mode in [HistoryMode::CumPercent, HistoryMode::CumAmount] {
            let d = history_row_display(&no_cost, mode, false);
            assert_eq!(d.text, "52000", "mode={mode:?} 应回退显示持仓额");
            assert_eq!(d.signed, None, "回退行无涨跌语义，未自定义时走颜色链");
        }
        // 隐私模式下回退同为金额 → 打码
        assert_eq!(
            history_row_display(&no_cost, HistoryMode::CumAmount, true).text,
            BOTTOM_MASKED
        );
    }

    /// 行情快照未就绪（首次刷新前）→ 占位符，不显示误导性的 0（Label 档不受影响）
    #[test]
    fn history_shows_placeholder_before_first_quote() {
        let empty = history_spec(None, None, None);
        for mode in [
            HistoryMode::CumPercent,
            HistoryMode::CumAmount,
            HistoryMode::HoldingAmount,
        ] {
            let d = history_row_display(&empty, mode, false);
            assert_eq!(d.text, BOTTOM_PLACEHOLDER, "mode={mode:?}");
            assert_eq!(d.signed, None);
        }
        assert_eq!(
            history_row_display(&empty, HistoryMode::Label, false).text,
            "历史",
            "快照未就绪不影响名称文字档"
        );
    }

    /// 第一行档位解析：接受四档（含 label=名称文字），非法/缺省回落 label
    #[test]
    fn history_top_mode_parse_accepts_four_values() {
        assert_eq!(HistoryMode::parse_top(Some("label")), HistoryMode::Label);
        assert_eq!(
            HistoryMode::parse_top(Some("cumPercent")),
            HistoryMode::CumPercent
        );
        assert_eq!(
            HistoryMode::parse_top(Some("cumAmount")),
            HistoryMode::CumAmount
        );
        assert_eq!(
            HistoryMode::parse_top(Some("holdingAmount")),
            HistoryMode::HoldingAmount
        );
        assert_eq!(HistoryMode::parse_top(Some(" bogus ")), HistoryMode::Label);
        assert_eq!(HistoryMode::parse_top(None), HistoryMode::Label);
    }

    /// 第二行档位解析：只接受三档数值；`label` 是第一行专属档，必须判非法并回落 CumAmount
    /// （否则第二行会渲染出名称文字）
    #[test]
    fn history_bottom_mode_parse_rejects_label() {
        assert_eq!(
            HistoryMode::parse_bottom(Some("cumPercent")),
            HistoryMode::CumPercent
        );
        assert_eq!(
            HistoryMode::parse_bottom(Some("cumAmount")),
            HistoryMode::CumAmount
        );
        assert_eq!(
            HistoryMode::parse_bottom(Some("holdingAmount")),
            HistoryMode::HoldingAmount
        );
        assert_eq!(
            HistoryMode::parse_bottom(Some("label")),
            HistoryMode::CumAmount
        );
        assert_eq!(
            HistoryMode::parse_bottom(Some(" bogus ")),
            HistoryMode::CumAmount
        );
        assert_eq!(HistoryMode::parse_bottom(None), HistoryMode::CumAmount);
    }

    /// 当日收益实例路径不受槽位改造影响（回归护栏）
    #[test]
    fn day_pnl_display_unchanged() {
        let spec = InstanceSpec::day_pnl(
            INSTANCE_OVERVIEW.to_string(),
            "总览".to_string(),
            1.234,
            567.0,
            true,
        );
        assert_eq!(day_pnl_display(&spec, false).text, "+1.23%");
        assert_eq!(day_pnl_display(&spec, true).text, "+567");
        assert_eq!(day_pnl_display(&spec, false).signed, Some(1.234));
        assert_eq!(day_pnl_display(&spec, true).signed, Some(567.0));
        // 当日收益实例上行恒为名称文字（无涨跌语义 → 走分组色/全局链）
        let top = RowDisplay::text(spec.top.clone());
        assert_eq!(top.text, "总览");
        assert_eq!(top.signed, None);
    }

    #[test]
    fn group_id_roundtrip_and_event_safe() {
        for name in [
            "人工智能",
            "测试-分组",
            "A B_C.D",
            "a/b:中",
            "x%y",
            "纯ASCII",
        ] {
            let enc = encode_group_id(name);
            // 事件名合法字符（tauri 校验：字母数字 + - / : _，`%` 非法）→ id 后缀必须只含字母数字
            assert!(
                enc.chars().all(|c| c.is_ascii_alphanumeric()),
                "enc 含非法事件名字符: {enc}",
            );
            assert_eq!(decode_group_id(&enc), name, "roundtrip 失败: {name}");
        }
    }
}
