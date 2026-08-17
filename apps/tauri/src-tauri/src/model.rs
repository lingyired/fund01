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
    /// 菜单栏上行（分组名/总览）固定文字颜色（hex，默认 #ffffff）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menubar_top_color: Option<String>,
    /// 各持仓分组自定义的上行文字颜色（key=分组名，''=未分组；value=hex）。
    /// 未配置的分组回落 menubar_top_color（全局）
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
            silent_start: None,
            selected_indices: None,
            menubar_hidden_groups: None,
            menubar_layout: None,
            menubar_top_font_size: None,
            menubar_bottom_font_size: None,
            menubar_equal_font_size: None,
            menubar_show_amount: None,
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
