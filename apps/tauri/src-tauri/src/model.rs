//! serde 数据模型 —— 与 `packages/core/src/types.ts` 1:1 对应（camelCase JSON）。
//! 供命令返回、配置持久化（tauri-plugin-store）、内部计算共用。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 基金与配置
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FundRecord {
    pub code: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fund_key: Option<String>,
    /// 'hold' | 'watch'
    #[serde(rename = "type", default)]
    pub fund_type: String,
    /// 分组名 → 份额（'' 表示未分组）
    #[serde(default)]
    pub allocations: HashMap<String, f64>,
    /// 分组名 → 成本单价（元/份）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costs: Option<HashMap<String, f64>>,
    #[serde(default)]
    pub sectors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shares: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl FundRecord {
    /// 类型便捷判断（配置可能缺省，默认 watch）
    pub fn is_hold(&self) -> bool {
        self.fund_type == "hold"
    }

    /// 各分组份额之和
    pub fn total_shares(&self) -> f64 {
        if self.is_hold() {
            self.allocations.values().sum()
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_interval: Option<RefreshInterval>,
    /// 行情数据源：fundmnfinfo（默认，东财批量）/ fund123（蚂蚁基金）/ xiaobei（小倍养基）。
    /// 白名单归一化在 portfolio.rs normalize_config。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge_mode: Option<String>,
    /// 设置页「持仓」tab 浮动导航位置：top=顶部吸顶(默认) side=右侧悬浮
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holdings_nav_position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holding_groups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holding_group_orders: Option<HashMap<String, Vec<String>>>,
    /// 不纳入总览统计的持仓分组名列表（'' 表示未分组）。默认空 = 全部分组纳入。
    /// 被排除分组的持仓从总览汇总（菜单栏「总览」/角标/popup 汇总）剔除，但仍可在分组 Tab 查看。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview_excluded_groups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// 隐私模式：popup 金额打码为 ****，菜单栏/角标强制百分比。仅影响显示，不改数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_mode: Option<bool>,
    /// 静默启动（clash-verge-rev enable_silent_start 同款）：启动后不打开设置界面，仅常驻菜单栏
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silent_start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_indices: Option<Vec<String>>,
    /// 菜单栏隐藏的持仓分组名列表（'' 表示未分组）；不在列表的分组默认显示
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_hidden_groups: Option<Vec<String>>,
    /// 菜单栏布局模式：0=下大上小(默认) 2=等大（1=上大下小已移除）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_layout: Option<u8>,
    /// 菜单栏上行字体大小（pt，布局 0「下大上小」的上行小字，范围 7-10）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_font_size: Option<f64>,
    /// 菜单栏下行字体大小（pt，布局 0「下大上小」的下行大字，范围 10-14）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_bottom_font_size: Option<f64>,
    /// 菜单栏等大字号（pt，布局 2「等大」两行共用，范围 8-11，上限受插件原生 clamp 限制）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_equal_font_size: Option<f64>,
    /// 菜单栏数值显示方式：false=收益率百分比(默认) true=收益额（k/w/kw 简写）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_show_amount: Option<bool>,
    /// 菜单栏/任务栏「历史」实例总开关（默认 false）。开启后在全部实例最前面增加一项，
    /// 展示整个组合的累计表现（口径见 menubar_history_mode）。
    /// 关闭 = 该实例不存在；macOS ⌘-拖出该实例等价于把本项置 false。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_enabled: Option<bool>,
    /// 「历史」实例的上行名称（默认「历史」）。trim 后空回落默认，超 8 字符截断。
    /// ⚠️ 只在该实例第一行档位为 label 时显示（见 menubar_history_top_mode）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_label: Option<String>,
    /// 「历史」实例第一行内容档：label(默认)=名称文字 / cumPercent=历史收益涨跌幅 /
    /// cumAmount=历史收益额 / holdingAmount=当前持仓额。四档与第二行对等。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_top_mode: Option<String>,
    /// 「历史」实例第二行内容档：cumAmount(默认)=历史收益额 / cumPercent=历史收益涨跌幅 /
    /// holdingAmount=当前持仓额。收益两档在未录入成本时回退显示当前持仓额。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_mode: Option<String>,
    /// 「历史」实例第二行自定义颜色（#rrggbb；空串=未自定义，按涨跌/跟随语义取色）。
    /// 第一行自定义色不走本字段，而是复用 menubar_group_colors 的 "__history__" key。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_bottom_color: Option<String>,
    /// 「历史」实例数值档的取数口径：latest(默认)=含今日（当前净值/盘中估值，实时跳动）/
    /// confirmed=只用已公布净值（盘中即昨日净值，披露前数字稳定）。
    /// 只影响历史实例三个数值档（收益额/涨跌幅/持仓额），不影响「当日收益」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_history_valuation: Option<String>,
    /// 菜单栏上行字体族名（macOS font family，默认空=系统字体）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_font: Option<String>,
    /// 菜单栏下行字体族名（macOS font family，默认空=系统字体）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_bottom_font: Option<String>,
    /// 菜单栏上行是否加粗（默认 false）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_bold: Option<bool>,
    /// 菜单栏下行是否加粗（默认 true）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_bottom_bold: Option<bool>,
    /// 菜单栏上行文字水平对齐：0=左对齐(默认) 1=居中 2=右对齐（插件 v1.5.0+ set_alignment）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_align: Option<u8>,
    /// 菜单栏下行文字水平对齐：0=左对齐(默认) 1=居中 2=右对齐（插件 v1.5.0+ set_alignment）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_bottom_align: Option<u8>,
    /// 菜单栏上行（分组名/总览）固定文字颜色（hex，默认 #ffffff）。
    /// 两端口径一致：None 或等于默认白 → 视为「未自定义」，下发 ColorStyle::Default
    /// 跟随系统文字色、深浅色模式自适应（Windows 见 taskband.rs::top_color_style；
    /// macOS 见 menubar.rs::top_color_style，multiline-menubar v1.7.0 起绘制时解析
    /// NSColor.labelColor 并在深浅色切换时自动重绘）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_color: Option<String>,
    /// 各持仓分组自定义的上行文字颜色（key=分组名，''=未分组；value=hex）。
    /// 未配置的分组回落 menubar_top_color（全局），全局也未自定义时两端都跟随系统色
    ///（见 menubar.rs / taskband.rs 的 top_color_style）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_group_colors: Option<HashMap<String, String>>,
    /// 菜单栏下行涨色（hex，默认 #FF4F44）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_rise_color: Option<String>,
    /// 菜单栏下行跌色（hex，默认 #34C759）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_fall_color: Option<String>,
    /// 菜单栏下行平色（hex，默认 #8e8e93）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_flat_color: Option<String>,
    /// 各任务栏分组停靠侧（仅 Windows 生效）：'left'|'right'（缺省=右侧）。
    /// key 约定与 menubar_hidden_groups 一致（''=未分组、'__overview__'=总览、其余=分组名）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_group_sides: Option<HashMap<String, String>>,
    /// 任务栏分组全局停靠覆盖（仅 Windows 生效）：None/'follow'=跟随 menubar_group_sides
    /// 逐分组设置；'left'/'right'=强制所有实例停靠到对应侧（改为 follow 后逐分组设置恢复生效）。
    /// 对应 taskband.rs::side_for 的统一覆盖，用于一次把所有分组移到同一边。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_global_side: Option<String>,
    /// 任务栏相邻实例间距（仅 Windows 生效，物理像素，缺省=4 与插件 set_margin 默认一致）。
    /// 对应 taskband 插件全局 set_margin。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_item_margin: Option<i32>,
    /// 任务栏分组整体外边距（仅 Windows 生效，物理像素）：left=左缘留白 right=右缘留白
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_edge_margins: Option<EdgeMargins>,
    /// popup 分组 Tab 是否显示两行收益详情（默认 true：分组名 + 当日收益）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_tab_show_detail: Option<bool>,
    /// popup 分组 Tab 收益详情显示方式："percent"(默认) | "amount"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_tab_detail_mode: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            refresh_interval: None,
            quote_source: None,
            badge_mode: None,
            holdings_nav_position: None,
            holding_groups: None,
            holding_group_orders: None,
            overview_excluded_groups: None,
            theme: None,
            privacy_mode: None,
            silent_start: None,
            selected_indices: None,
            menubar_hidden_groups: None,
            menubar_layout: None,
            menubar_top_font_size: None,
            menubar_bottom_font_size: None,
            menubar_equal_font_size: None,
            menubar_show_amount: None,
            menubar_history_enabled: None,
            menubar_history_label: None,
            menubar_history_top_mode: None,
            menubar_history_mode: None,
            menubar_history_bottom_color: None,
            menubar_history_valuation: None,
            menubar_top_font: None,
            menubar_bottom_font: None,
            menubar_top_bold: None,
            menubar_bottom_bold: None,
            menubar_top_align: None,
            menubar_bottom_align: None,
            menubar_top_color: None,
            menubar_group_colors: None,
            menubar_rise_color: None,
            menubar_fall_color: None,
            menubar_flat_color: None,
            menubar_group_sides: None,
            menubar_global_side: None,
            menubar_item_margin: None,
            menubar_edge_margins: None,
            group_tab_show_detail: None,
            group_tab_detail_mode: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefreshInterval {
    pub trading: u64,
    pub non_trading: u64,
}

/// 任务栏分组整体外边距（仅 Windows 生效，物理像素；对应 taskband 插件 set_edge_margins）。
/// left=距任务栏左缘留白（左侧分组用），right=距通知区域/右缘留白（右侧分组用）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EdgeMargins {
    pub left: i32,
    pub right: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub settings: AppSettings,
    #[serde(default)]
    pub holdings: HashMap<String, FundRecord>,
}

// ---------------------------------------------------------------------------
// 行情
// ---------------------------------------------------------------------------

/// 关联板块行情（小倍 `relatedIndustryV2`）—— **实时行情，不持久化**。
/// 与 `packages/core/src/types.ts` 的 `SectorQuote` 1:1 对应。
///
/// ⚠️ 语义边界：这是**板块指数的涨跌幅**，不是本基金的收益，两者不可混用。
/// 境内板块随 A 股盘中实时变动；美股板块为「北京时间 21:30 → 次日 04:00」场次，
/// 白天取值即昨夜收盘值（2026-09-15 实测）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectorQuote {
    /// 板块名（小倍 `themeName`，如「白酒」「纳指100」「海外科技」）
    pub name: String,
    /// 板块指数涨跌幅（百分数，-0.37 表示 −0.37%）；取不到为 None
    pub change: Option<f64>,
    /// 板块指数代码（小倍 `indexCode`，如 399997.SZ / 100.NDX100 / .NDXT）
    pub index_code: String,
    /// 市场类型（小倍 `type`）：`A` 境内 / `USA` 美股场次（跨北京自然日）
    pub market: String,
}

/// 与 services/fund.ts 的 FundQuote 对应（provider 产出，计算层消费）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundQuote {
    pub code: String,
    pub name: String,
    pub fund_key: String,
    pub day_growth: Option<f64>,
    pub estimate_growth: Option<f64>,
    pub percent: Option<f64>,
    pub percent_source: Option<String>,
    pub net_value: Option<f64>,
    pub estimate_net_value: Option<f64>,
    pub prev_net_value: Option<f64>,
    pub net_value_date: String,
    pub time: Option<String>,
    pub trend: Vec<TrendPoint>,
    pub sectors: Vec<String>,
    /// 关联板块行情（仅 xiaobei 源填充，其余源为空 —— 不产伪数据）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sector_quotes: Vec<SectorQuote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_calc: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_qdii: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub time: String,
    pub growth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value: Option<f64>,
}

/// 前端展示用持仓行（FundRecord + 行情字段）——与 types.ts FundQuoteRow 对应
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FundQuoteRow {
    #[serde(flatten)]
    pub fund: FundRecord,
    pub amount: f64,
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_growth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_growth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_net_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_net_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default)]
    pub trend: Vec<TrendPoint>,
    /// 关联板块行情（透传自 FundQuote；空表示该数据源无板块数据）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sector_quotes: Vec<SectorQuote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_updated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cum_pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cum_pnl_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_qdii: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsSummary {
    pub total_amount: f64,
    /// 全部纳入总览的持仓 @**含今日**市值（= Σ 份额 × 当前净值，盘中即估值净值）。
    /// 与 `total_amount`（@已公布净值）成对，供菜单栏「历史」项数值口径切换
    /// （`menubar_history_valuation=latest`）使用；popup 汇总仍用 `total_amount`。
    pub total_amount_latest: f64,
    /// **已录入成本**那部分持仓 @已公布净值市值。持有收益只统计录入成本的持仓，
    /// 故「已确认」口径的总览收益 = `total_costed_amount − total_cost`；
    /// 部分持仓未录成本时它小于 `total_amount`。
    pub total_costed_amount: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bod_total: Option<f64>,
    pub total_pnl: f64,
    pub total_pnl_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cum_pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cum_pnl_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsPayload {
    pub summary: HoldingsSummary,
    pub list: Vec<FundQuoteRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexItem {
    pub code: String,
    pub name: String,
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<f64>,
    /// 行情拉取失败时的简短错误码（NET/TIMEOUT/HTTP/NODATA/PARSE），UI 显示错误态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundHistoryPoint {
    pub date: String,
    pub net_value: f64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundHistoryPayload {
    pub code: String,
    pub range: String,
    pub period_percent: Option<f64>,
    pub points: Vec<FundHistoryPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHistoryPoint {
    pub date: String,
    pub close: f64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHistoryPayload {
    pub code: String,
    pub name: String,
    pub range: String,
    pub period_percent: Option<f64>,
    pub points: Vec<IndexHistoryPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundIntradayPayload {
    pub points: Vec<TrendPoint>,
    pub latest: Option<TrendPoint>,
    pub fund_key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolveFundPayload {
    pub code: String,
    pub name: String,
    pub fund_key: String,
    #[serde(default)]
    pub sectors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_net_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_net_value_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_value_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_mismatch: Option<NameMismatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_corrected: Option<CodeCorrected>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameMismatch {
    pub input: String,
    pub officials: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeCorrected {
    pub from: String,
    pub to: String,
    pub from_name: String,
    pub to_name: String,
    pub matched_by: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteUpdate {
    pub holdings: Option<HoldingsPayload>,
    pub indices: Option<Vec<IndexItem>>,
    pub time: i64,
}

/// 前端「添加基金 / 导入」时 resolve_fund 命令的入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveFundRequest {
    pub code: String,
    #[serde(rename = "type")]
    pub fund_type: Option<String>,
    pub name: Option<String>,
    pub sectors: Option<Vec<String>>,
}

/// 前端「分时走势」命令入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundIntradayRequest {
    pub code: String,
    pub fund_key: Option<String>,
    pub name: Option<String>,
}
