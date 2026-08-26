//! 配置归一化 —— 对应 `packages/core/src/portfolioLogic.ts` 1:1 迁移。

use std::collections::{HashMap, HashSet};

use crate::model::{AppConfig, AppSettings, FundRecord, RefreshInterval};

pub const DEFAULT_SELECTED_INDICES: [&str; 5] = ["000001", "399001", "399006", "000300", "NDX"];
pub const MAX_SELECTED_INDICES: usize = 5;

pub const DEFAULT_REFRESH_INTERVAL: RefreshInterval = RefreshInterval {
    trading: 60,
    non_trading: 600,
};
pub const MIN_REFRESH_INTERVAL: RefreshInterval = RefreshInterval {
    trading: 30,
    non_trading: 300,
};

pub fn default_config() -> AppConfig {
    AppConfig {
        settings: AppSettings {
            refresh_interval: Some(DEFAULT_REFRESH_INTERVAL),
            quote_source: Some("fundmnfinfo".to_string()),
            badge_mode: Some("percent".to_string()),
            holdings_nav_position: Some("top".to_string()),
            holding_groups: Some(vec![]),
            holding_group_orders: Some(HashMap::new()),
            overview_excluded_groups: Some(vec![]),
            theme: Some("system".to_string()),
            silent_start: Some(false),
            privacy_mode: Some(false),
            selected_indices: Some(DEFAULT_SELECTED_INDICES.iter().map(|s| s.to_string()).collect()),
            menubar_hidden_groups: Some(vec![]),
            menubar_layout: Some(0),
            menubar_top_font_size: Some(7.0),
            menubar_bottom_font_size: Some(11.0),
            menubar_equal_font_size: Some(9.0),
            menubar_show_amount: Some(false),
            menubar_top_font: Some(String::new()),
            menubar_bottom_font: Some(String::new()),
            menubar_top_bold: Some(false),
            menubar_bottom_bold: Some(true),
            menubar_top_align: Some(0),
            menubar_bottom_align: Some(0),
            menubar_top_color: Some("#ffffff".to_string()),
            menubar_group_colors: Some(HashMap::new()),
            menubar_rise_color: Some("#FF4F44".to_string()),
            menubar_fall_color: Some("#34C759".to_string()),
            menubar_flat_color: Some("#8e8e93".to_string()),
            group_tab_show_detail: Some(true),
            group_tab_detail_mode: Some("percent".to_string()),
        },
        holdings: HashMap::new(),
    }
}

/// 把用户配置的刷新间隔夹到合法区间
pub fn clamp_refresh_interval(raw: Option<&RefreshInterval>) -> RefreshInterval {
    let raw = raw.unwrap_or(&DEFAULT_REFRESH_INTERVAL);
    let trading = if raw.trading == 0 {
        DEFAULT_REFRESH_INTERVAL.trading
    } else {
        raw.trading.max(MIN_REFRESH_INTERVAL.trading)
    };
    let non_trading = if raw.non_trading == 0 {
        DEFAULT_REFRESH_INTERVAL.non_trading
    } else {
        raw.non_trading.max(MIN_REFRESH_INTERVAL.non_trading)
    };
    RefreshInterval { trading, non_trading }
}

fn pad6(code: &str) -> String {
    let c = code.trim();
    if c.len() >= 6 {
        c.to_string()
    } else {
        format!("{:0>6}", c)
    }
}

/// 归一化单只基金（对应 normalizeFund）
pub fn normalize_fund(
    raw: &serde_json::Value,
    prev: Option<&FundRecord>,
    fallback_type: &str,
) -> Option<FundRecord> {
    let code_raw = raw.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let code = pad6(code_raw);
    if !(code.len() == 6 && code.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let is_hold = fallback_type == "hold";
    let mut allocations: HashMap<String, f64> = HashMap::new();
    if is_hold {
        if let Some(a) = raw.get("allocations").and_then(|v| v.as_object()) {
            for (g, s) in a {
                let shares = s.as_f64().unwrap_or(0.0);
                // 保留 0 份额分组：0 金额基金 = 关注/待加仓，视为正常持仓记录
                if shares >= 0.0 {
                    allocations.insert(g.clone(), shares);
                }
            }
        } else if let Some(prev_alloc) = prev.and_then(|p| if p.allocations.is_empty() { None } else { Some(&p.allocations) }) {
            allocations = prev_alloc.clone();
        } else {
            // 旧版兼容：shares + group/groups
            let old_shares = raw
                .get("shares")
                .and_then(|v| v.as_f64())
                .or_else(|| prev.and_then(|p| p.shares))
                .unwrap_or(0.0);
            if old_shares > 0.0 {
                let groups: Vec<String> = if let Some(g) = raw.get("groups").and_then(|v| v.as_array()) {
                    g.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect()
                } else if let Some(g) = raw.get("group").and_then(|v| v.as_str()) {
                    if g.is_empty() { vec!["".to_string()] } else { vec![g.to_string()] }
                } else if let Some(prev) = prev {
                    if !prev.groups.as_deref().unwrap_or(&[]).is_empty() {
                        prev.groups.clone().unwrap()
                    } else if let Some(g) = &prev.group {
                        vec![g.clone()]
                    } else {
                        vec!["".to_string()]
                    }
                } else {
                    vec!["".to_string()]
                };
                let g = groups.first().cloned().unwrap_or_default().trim().to_string();
                allocations.insert(g, old_shares);
            }
        }
    }

    // costs：与 allocations 同 key；仅保留对应 allocation 存在且 cost>0 的项
    let mut costs: Option<HashMap<String, f64>> = None;
    if is_hold {
        let raw_costs = raw
            .get("costs")
            .and_then(|v| v.as_object())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect::<HashMap<_, _>>())
            .or_else(|| prev.and_then(|p| p.costs.clone()));
        if let Some(rc) = raw_costs {
            let cleaned: HashMap<String, f64> = rc
                .into_iter()
                .filter(|(g, c)| allocations.contains_key(g) && *c > 0.0)
                .collect();
            if !cleaned.is_empty() {
                costs = Some(cleaned);
            }
        }
    }

    let fund_type = match raw.get("type").and_then(|v| v.as_str()) {
        Some("hold") => "hold".to_string(),
        Some("watch") => "watch".to_string(),
        _ => prev
            .map(|p| p.fund_type.clone())
            .unwrap_or_else(|| fallback_type.to_string()),
    };
    let sectors: Vec<String> = raw
        .get("sectors")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect())
        .or_else(|| prev.map(|p| p.sectors.clone()))
        .unwrap_or_default();

    let name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| prev.map(|p| p.name.clone()))
        .unwrap_or_else(|| code.clone());

    Some(FundRecord {
        code,
        name,
        fund_key: raw
            .get("fundKey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| prev.and_then(|p| p.fund_key.clone()))
            .filter(|s| !s.is_empty()),
        fund_type,
        allocations,
        costs,
        sectors,
        shares: raw.get("shares").and_then(|v| v.as_f64()).or_else(|| prev.and_then(|p| p.shares)),
        group: raw.get("group").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| prev.and_then(|p| p.group.clone())),
        groups: raw
            .get("groups")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect())
            .or_else(|| prev.and_then(|p| p.groups.clone())),
        created_at: prev
            .and_then(|p| p.created_at.clone())
            .or_else(|| raw.get("createdAt").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .or(Some(now.clone())),
        updated_at: Some(now),
    })
}

/// 把一个基金 map 归一化（强制指定 type）
pub fn normalize_fund_map(source: &serde_json::Value, fallback_type: &str) -> HashMap<String, FundRecord> {
    let mut out = HashMap::new();
    let Some(obj) = source.as_object() else { return out };
    for (key, raw) in obj {
        let code_raw = raw.get("code").and_then(|v| v.as_str()).unwrap_or(key);
        let mut copy = raw.clone();
        if let Some(o) = copy.as_object_mut() {
            o.insert("code".to_string(), serde_json::Value::String(pad6(code_raw)));
            o.insert("type".to_string(), serde_json::Value::String(fallback_type.to_string()));
        }
        if let Some(f) = normalize_fund(&copy, None, fallback_type) {
            out.insert(f.code.clone(), f);
        }
    }
    out
}

/// 配置归一化（对应 normalizeConfig，兼容旧 funds 字段）
pub fn normalize_config(payload: &serde_json::Value) -> AppConfig {
    let mut holdings: HashMap<String, FundRecord> = HashMap::new();

    // 旧格式：单一 funds map（兼容迁移；type != "hold" 的旧自选条目不再纳入持仓）
    if let Some(funds) = payload.get("funds").and_then(|v| v.as_object()) {
        for (key, raw) in funds {
            let code_raw = raw.get("code").and_then(|v| v.as_str()).unwrap_or(key);
            let code = pad6(code_raw);
            if !(code.len() == 6 && code.chars().all(|c| c.is_ascii_digit())) {
                continue;
            }
            let t = if raw.get("type").and_then(|v| v.as_str()) == Some("hold") { "hold" } else { "watch" };
            let mut copy = raw.clone();
            if let Some(o) = copy.as_object_mut() {
                o.insert("code".to_string(), serde_json::Value::String(code));
                o.insert("type".to_string(), serde_json::Value::String(t.to_string()));
            }
            if t == "hold" {
                if let Some(f) = normalize_fund(&copy, None, t) {
                    holdings.insert(f.code.clone(), f);
                }
            }
        }
    }

    // 新格式覆盖
    for (k, v) in normalize_fund_map(&payload.get("holdings").cloned().unwrap_or(serde_json::Value::Null), "hold") {
        holdings.insert(k, v);
    }

    // holdingGroups：去重 + 去空白 + 保序
    let mut holding_groups: Vec<String> = Vec::new();
    if let Some(groups) = payload.pointer("/settings/holdingGroups").and_then(|v| v.as_array()) {
        for g in groups {
            let name = g.as_str().unwrap_or("").trim().to_string();
            if !name.is_empty() && !holding_groups.contains(&name) {
                holding_groups.push(name);
            }
        }
    }

    // holdingGroupOrders：仅保留有效分组 + 6 位 code
    let mut holding_group_orders: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(orders) = payload.pointer("/settings/holdingGroupOrders").and_then(|v| v.as_object()) {
        for (g, list) in orders {
            let Some(list) = list.as_array() else { continue };
            let mut seen = HashSet::new();
            let cleaned: Vec<String> = list
                .iter()
                .filter_map(|c| {
                    let code = pad6(c.as_str().unwrap_or(""));
                    if code.len() == 6 && code.chars().all(|x| x.is_ascii_digit()) && seen.insert(code.clone()) {
                        Some(code)
                    } else {
                        None
                    }
                })
                .collect();
            if !cleaned.is_empty() {
                holding_group_orders.insert(g.clone(), cleaned);
            }
        }
    }

    let settings_raw = payload.get("settings");
    // overviewExcludedGroups：不纳入总览的分组，去重保序，仅保留 ''(未分组) 或有效分组
    let mut overview_excluded_groups: Vec<String> = Vec::new();
    if let Some(h) = settings_raw
        .and_then(|s| s.get("overviewExcludedGroups"))
        .and_then(|v| v.as_array())
    {
        for g in h {
            let key = g.as_str().unwrap_or("").trim().to_string();
            if (key.is_empty() || holding_groups.contains(&key))
                && !overview_excluded_groups.contains(&key)
            {
                overview_excluded_groups.push(key);
            }
        }
    }
    // menubarHiddenGroups：保留 ''(未分组)、__overview__(总览被 ⌘-拖出)，去重保序，只留有效分组
    let mut menubar_hidden_groups: Vec<String> = Vec::new();
    if let Some(h) = settings_raw.and_then(|s| s.get("menubarHiddenGroups")).and_then(|v| v.as_array()) {
        for g in h {
            let key = g.as_str().unwrap_or("").trim().to_string();
            if (key.is_empty() || key == MENUBAR_OVERVIEW_KEY || holding_groups.contains(&key))
                && !menubar_hidden_groups.contains(&key)
            {
                menubar_hidden_groups.push(key);
            }
        }
    }
    // menubarLayout：仅 0|2 合法（1=上大下小已移除，回落 0）
    let menubar_layout: u8 = match settings_raw.and_then(|s| s.get("menubarLayout")).and_then(|v| v.as_u64()) {
        Some(2) => 2,
        _ => 0,
    };
    // 字号（位置语义，clamp 到布局对应范围）；未设置时按布局默认（与插件原生默认一致 0:7/11 2:9/9）。
    // 等大上限 11 受插件 v1.2.0 原生 equal clamp 限制，勿改插件
    let (d_top, d_bottom) = if menubar_layout == 2 { (9.0, 9.0) } else { (7.0, 11.0) };
    let clampf = |v: Option<f64>, d: f64, lo: f64, hi: f64| v.map(|x| x.clamp(lo, hi)).unwrap_or(d);
    let menubar_top_font_size = clampf(
        settings_raw.and_then(|s| s.get("menubarTopFontSize")).and_then(|v| v.as_f64()),
        d_top,
        7.0,
        10.0,
    );
    let menubar_bottom_font_size = clampf(
        settings_raw.and_then(|s| s.get("menubarBottomFontSize")).and_then(|v| v.as_f64()),
        d_bottom,
        10.0,
        14.0,
    );
    let menubar_equal_font_size = clampf(
        settings_raw.and_then(|s| s.get("menubarEqualFontSize")).and_then(|v| v.as_f64()),
        9.0,
        8.0,
        11.0,
    );
    let menubar_show_amount = settings_raw
        .and_then(|s| s.get("menubarShowAmount").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    // 菜单栏展示自定义项：字体（trim，空串=系统字体）、加粗（bool）、颜色（#rrggbb hex，非法回落默认）
    let font_of = |key: &str, d: &str| {
        settings_raw
            .and_then(|s| s.get(key).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| d.to_string())
    };
    let color_of = |key: &str, d: &str| {
        settings_raw
            .and_then(|s| s.get(key).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
            .filter(|s| is_hex_color(s))
            .unwrap_or_else(|| d.to_string())
    };
    let bool_of = |key: &str, d: bool| {
        settings_raw
            .and_then(|s| s.get(key).and_then(|v| v.as_bool()))
            .unwrap_or(d)
    };
    // 对齐：仅 0|1|2 合法（0=左 1=中 2=右，插件 v1.5.0+），非法回落 0
    let align_of = |key: &str| -> u8 {
        match settings_raw.and_then(|s| s.get(key)).and_then(|v| v.as_u64()) {
            Some(1) => 1,
            Some(2) => 2,
            _ => 0,
        }
    };
    let menubar_top_font = font_of("menubarTopFont", "");
    let menubar_bottom_font = font_of("menubarBottomFont", "");
    let menubar_top_bold = bool_of("menubarTopBold", false);
    let menubar_bottom_bold = bool_of("menubarBottomBold", true);
    let menubar_top_align = align_of("menubarTopAlign");
    let menubar_bottom_align = align_of("menubarBottomAlign");
    let menubar_top_color = color_of("menubarTopColor", "#ffffff");
    let menubar_group_colors: HashMap<String, String> = settings_raw
        .and_then(|s| s.get("menubarGroupColors"))
        .and_then(|v| v.as_object())
        .map(|obj| {
            let mut map = HashMap::new();
            for (k, v) in obj {
                let key = k.trim().to_string();
                if key.is_empty() || key == MENUBAR_OVERVIEW_KEY || holding_groups.contains(&key) {
                    if let Some(hex) = v
                        .as_str()
                        .map(|s| s.trim().to_string())
                        .filter(|s| is_hex_color(s))
                    {
                        map.insert(key, hex);
                    }
                }
            }
            map
        })
        .unwrap_or_default();
    let menubar_rise_color = color_of("menubarRiseColor", "#FF4F44");
    let menubar_fall_color = color_of("menubarFallColor", "#34C759");
    let menubar_flat_color = color_of("menubarFlatColor", "#8e8e93");
    // popup 分组 Tab 收益详情：默认开启（true）；mode 仅 "amount" 合法，否则 percent
    let group_tab_show_detail = settings_raw
        .and_then(|s| s.get("groupTabShowDetail").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    let group_tab_detail_mode = match settings_raw
        .and_then(|s| s.get("groupTabDetailMode").and_then(|v| v.as_str()))
    {
        Some("amount") => "amount".to_string(),
        _ => "percent".to_string(),
    };
    let quote_source = match settings_raw.and_then(|s| s.get("quoteSource").and_then(|v| v.as_str())) {
        Some("fund123") => "fund123".to_string(),
        Some("xiaobei") => "xiaobei".to_string(),
        _ => "fundmnfinfo".to_string(),
    };
    let badge_mode = match settings_raw.and_then(|s| s.get("badgeMode").and_then(|v| v.as_str())) {
        Some("amount") | Some("hidden") => settings_raw.unwrap().get("badgeMode").unwrap().as_str().unwrap().to_string(),
        _ => "percent".to_string(),
    };
    let holdings_nav_position = if settings_raw.and_then(|s| s.get("holdingsNavPosition").and_then(|v| v.as_str())) == Some("side") {
        "side".to_string()
    } else {
        "top".to_string()
    };
    let theme = match settings_raw.and_then(|s| s.get("theme").and_then(|v| v.as_str())) {
        Some("light") | Some("dark") | Some("system") => settings_raw.unwrap().get("theme").unwrap().as_str().unwrap().to_string(),
        _ => "system".to_string(),
    };
    let selected_indices = settings_raw
        .and_then(|s| s.get("selectedIndices").and_then(|v| v.as_array()))
        .filter(|a| !a.is_empty())
        .map(|a| {
            let mut seen = HashSet::new();
            a.iter()
                .filter_map(|c| c.as_str())
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty() && seen.insert(c.clone()))
                .take(MAX_SELECTED_INDICES)
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_SELECTED_INDICES.iter().map(|s| s.to_string()).collect());

    let refresh_interval = clamp_refresh_interval(
        settings_raw
            .and_then(|s| s.get("refreshInterval"))
            .and_then(|v| {
                let t = v.get("trading").and_then(|x| x.as_f64());
                let n = v.get("nonTrading").and_then(|x| x.as_f64());
                t.zip(n).map(|(t, n)| RefreshInterval { trading: t as u64, non_trading: n as u64 })
            })
            .as_ref(),
    );

    // silentStart：静默启动（clash-verge-rev enable_silent_start 同款），默认 false
    let silent_start = settings_raw
        .and_then(|s| s.get("silentStart"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // privacyMode：隐私模式，popup 金额打码 + 菜单栏/角标强制百分比，默认 false
    let privacy_mode = settings_raw
        .and_then(|s| s.get("privacyMode"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    AppConfig {
        settings: AppSettings {
            refresh_interval: Some(refresh_interval),
            quote_source: Some(quote_source),
            badge_mode: Some(badge_mode),
            holdings_nav_position: Some(holdings_nav_position),
            holding_groups: Some(holding_groups),
            holding_group_orders: Some(holding_group_orders),
            overview_excluded_groups: Some(overview_excluded_groups),
            theme: Some(theme),
            silent_start: Some(silent_start),
            privacy_mode: Some(privacy_mode),
            selected_indices: Some(selected_indices),
            menubar_hidden_groups: Some(menubar_hidden_groups),
            menubar_layout: Some(menubar_layout),
            menubar_top_font_size: Some(menubar_top_font_size),
            menubar_bottom_font_size: Some(menubar_bottom_font_size),
            menubar_equal_font_size: Some(menubar_equal_font_size),
            menubar_show_amount: Some(menubar_show_amount),
            menubar_top_font: Some(menubar_top_font),
            menubar_bottom_font: Some(menubar_bottom_font),
            menubar_top_bold: Some(menubar_top_bold),
            menubar_bottom_bold: Some(menubar_bottom_bold),
            menubar_top_align: Some(menubar_top_align),
            menubar_bottom_align: Some(menubar_bottom_align),
            menubar_top_color: Some(menubar_top_color),
            menubar_group_colors: Some(menubar_group_colors),
            menubar_rise_color: Some(menubar_rise_color),
            menubar_fall_color: Some(menubar_fall_color),
            menubar_flat_color: Some(menubar_flat_color),
            group_tab_show_detail: Some(group_tab_show_detail),
            group_tab_detail_mode: Some(group_tab_detail_mode),
        },
        holdings,
    }
}

/// 校验 hex 颜色（#rrggbb，忽略大小写）
fn is_hex_color(s: &str) -> bool {
    s.len() == 7
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// 总览实例在 menubarGroupColors 中的固定 key（与 TS MENUBAR_OVERVIEW_KEY 对应）
pub const MENUBAR_OVERVIEW_KEY: &str = "__overview__";
