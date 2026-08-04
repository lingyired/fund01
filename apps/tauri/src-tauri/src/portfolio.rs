//! 配置归一化 —— 对应 `packages/core/src/portfolioLogic.ts` 1:1 迁移。

use std::collections::{HashMap, HashSet};

use crate::model::{AppConfig, AppSettings, FundRecord, GoldConfig, RefreshInterval};

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
            show_gold: true,
            refresh_interval: Some(DEFAULT_REFRESH_INTERVAL),
            quote_source: Some("fundmnfinfo".to_string()),
            badge_mode: Some("percent".to_string()),
            holding_groups: Some(vec![]),
            holding_group_orders: Some(HashMap::new()),
            theme: Some("system".to_string()),
            selected_indices: Some(DEFAULT_SELECTED_INDICES.iter().map(|s| s.to_string()).collect()),
            menubar_hidden_groups: Some(vec![]),
            menubar_layout: Some(0),
            menubar_top_font_size: Some(7.0),
            menubar_bottom_font_size: Some(12.0),
        },
        holdings: HashMap::new(),
        watchlist: HashMap::new(),
        gold: GoldConfig::default(),
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
                if shares > 0.0 {
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
    let mut watchlist: HashMap<String, FundRecord> = HashMap::new();

    // 旧格式：单一 funds map
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
            if let Some(f) = normalize_fund(&copy, None, t) {
                if t == "hold" {
                    holdings.insert(f.code.clone(), f);
                } else {
                    watchlist.insert(f.code.clone(), f);
                }
            }
        }
    }

    // 新格式覆盖
    for (k, v) in normalize_fund_map(&payload.get("holdings").cloned().unwrap_or(serde_json::Value::Null), "hold") {
        holdings.insert(k, v);
    }
    for (k, v) in normalize_fund_map(&payload.get("watchlist").cloned().unwrap_or(serde_json::Value::Null), "watch") {
        watchlist.insert(k, v);
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
    // menubarHiddenGroups：保留 ''(未分组)，去重保序，只留有效分组
    let mut menubar_hidden_groups: Vec<String> = Vec::new();
    if let Some(h) = settings_raw.and_then(|s| s.get("menubarHiddenGroups")).and_then(|v| v.as_array()) {
        for g in h {
            let key = g.as_str().unwrap_or("").trim().to_string();
            if (key.is_empty() || holding_groups.contains(&key)) && !menubar_hidden_groups.contains(&key) {
                menubar_hidden_groups.push(key);
            }
        }
    }
    // menubarLayout：0|1|2，非法回落 0
    let menubar_layout: u8 = match settings_raw.and_then(|s| s.get("menubarLayout")).and_then(|v| v.as_u64()) {
        Some(1) => 1,
        Some(2) => 2,
        _ => 0,
    };
    // 字号（位置语义，clamp 5-16）；未设置时按布局默认（与插件原生默认一致 0:7/12 1:12/7 2:9/9）
    let (d_top, d_bottom) = match menubar_layout {
        1 => (12.0, 7.0),
        2 => (9.0, 9.0),
        _ => (7.0, 12.0),
    };
    let clampf = |v: Option<f64>, d: f64| v.map(|x| x.clamp(5.0, 16.0)).unwrap_or(d);
    let menubar_top_font_size = clampf(
        settings_raw.and_then(|s| s.get("menubarTopFontSize")).and_then(|v| v.as_f64()),
        d_top,
    );
    let menubar_bottom_font_size = clampf(
        settings_raw.and_then(|s| s.get("menubarBottomFontSize")).and_then(|v| v.as_f64()),
        d_bottom,
    );
    let show_gold = settings_raw
        .and_then(|s| s.get("showGold").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    let quote_source = if settings_raw.and_then(|s| s.get("quoteSource").and_then(|v| v.as_str())) == Some("fund123") {
        "fund123".to_string()
    } else {
        "fundmnfinfo".to_string()
    };
    let badge_mode = match settings_raw.and_then(|s| s.get("badgeMode").and_then(|v| v.as_str())) {
        Some("amount") | Some("hidden") => settings_raw.unwrap().get("badgeMode").unwrap().as_str().unwrap().to_string(),
        _ => "percent".to_string(),
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

    let gold = GoldConfig {
        holding: payload.pointer("/gold/holding").and_then(|v| v.as_f64()).unwrap_or(0.0),
        avg_price: payload.pointer("/gold/avgPrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
    };

    AppConfig {
        settings: AppSettings {
            show_gold,
            refresh_interval: Some(refresh_interval),
            quote_source: Some(quote_source),
            badge_mode: Some(badge_mode),
            holding_groups: Some(holding_groups),
            holding_group_orders: Some(holding_group_orders),
            theme: Some(theme),
            selected_indices: Some(selected_indices),
            menubar_hidden_groups: Some(menubar_hidden_groups),
            menubar_layout: Some(menubar_layout),
            menubar_top_font_size: Some(menubar_top_font_size),
            menubar_bottom_font_size: Some(menubar_bottom_font_size),
        },
        holdings,
        watchlist,
        gold,
    }
}
