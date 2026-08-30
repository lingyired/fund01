//! 板块/主题推断 —— 对应 `packages/services/src/fund.ts` L255-439 迁移。
//! 纯逻辑 + 少量数据源调用（FundMNInverstPosition / FundMNBasicInformation）。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use tokio::sync::Mutex;

use crate::providers::{eastmoney_fund_get, pad6};

const COARSE_SECTORS: &[&str] = &[
    "有色金属",
    "化学制药",
    "医药生物",
    "食品饮料",
    "公用事业",
    "通信设备",
    "元件",
    "银行",
    "非银金融",
    "房地产",
    "电子",
    "计算机",
    "机械设备",
    "基础化工",
    "混业",
    "综合",
];

fn is_coarse(s: &str) -> bool {
    COARSE_SECTORS.contains(&s)
}

/// 板块是否需要刷新（对应 sectorsNeedRefresh）
pub fn sectors_need_refresh(sectors: &[String], name: &str) -> bool {
    if sectors.is_empty() {
        return true;
    }
    let n = name;
    if sectors.iter().any(|s| s == "有色金属") {
        return true;
    }
    if sectors
        .iter()
        .any(|s| s.contains("医药") || s == "化学制药")
        && n.contains("创新药")
    {
        return true;
    }
    if sectors.iter().any(|s| s == "半导体")
        && (n.contains("半导体材料") || n.contains("半导体设备"))
    {
        return true;
    }
    if sectors.iter().any(|s| s == "电力") && (n.contains("绿色电力") || n.contains("绿电"))
    {
        return true;
    }
    if sectors.iter().any(|s| s == "食品饮料") && n.contains("白酒") {
        return true;
    }
    false
}

/// 指数名 → 主题（对应 themeFromIndexName）
fn theme_from_index_name(index_name: &str) -> Vec<String> {
    let mut s = index_name.trim().to_string();
    if s.is_empty() || s == "--" {
        return vec![];
    }
    for _ in 0..3 {
        let next = strip_prefix_any(
            &s,
            &[
                "中证", "国证", "沪深", "上证", "深证", "标普", "恒生", "MSCI", "富时", "全指",
            ],
        );
        if next == s {
            break;
        }
        s = next;
    }
    let cleaned = s
        .replace("交易型开放式指数证券投资基金", "")
        .replace("全收益指数", "")
        .replace("净收益指数", "")
        .replace("价格指数", "")
        .replace("主题指数", "")
        .replace("产业指数", "")
        .replace("策略指数", "")
        .replace("指数", "")
        .replace("主题", "")
        .replace("产业", "")
        .replace(['(', ')', '（', '）', ' '], "")
        .trim()
        .to_string();
    if cleaned.is_empty() || cleaned.len() < 2 || cleaned.len() > 10 {
        return vec![];
    }
    vec![cleaned]
}

fn strip_prefix_any(s: &str, prefixes: &[&str]) -> String {
    for p in prefixes {
        if let Some(rest) = s.strip_prefix(p) {
            return rest.to_string();
        }
    }
    s.to_string()
}

/// 主题去重与精化（对应 finalizeThemes）
fn finalize_themes(list: Vec<String>) -> Vec<String> {
    // 去重 + trim + 过滤空
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for s in list {
        let t = s.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    // 粗类被细类覆盖
    let keep: Vec<bool> = out
        .iter()
        .map(|a| {
            if a == "半导体" && out.iter().any(|x| x != a && x.contains("半导体")) {
                return false;
            }
            if a == "半导体设备" && out.iter().any(|x| x.contains("半导体材料")) {
                return false;
            }
            if a == "医药" && out.contains(&"创新药".to_string()) {
                return false;
            }
            if a == "电力" && out.contains(&"绿色电力".to_string()) {
                return false;
            }
            if a == "新能源"
                && out
                    .iter()
                    .any(|x| ["锂矿", "光伏", "储能", "绿色电力"].contains(&x.as_str()))
            {
                return false;
            }
            if is_coarse(a) && out.iter().any(|x| !is_coarse(x)) {
                return false;
            }
            true
        })
        .collect();
    out = out
        .into_iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(a, _)| a)
        .collect();
    // 短词（≤4）覆盖其长词超集
    let shorts: Vec<String> = out
        .iter()
        .filter(|s| s.chars().count() <= 4)
        .cloned()
        .collect();
    if !shorts.is_empty() {
        let keep2: Vec<bool> = out
            .iter()
            .map(|s| {
                !(s.chars().count() > 4
                    && shorts.iter().any(|sh| s != sh && s.contains(sh.as_str())))
            })
            .collect();
        out = out
            .into_iter()
            .zip(keep2)
            .filter(|(_, k)| *k)
            .map(|(a, _)| a)
            .collect();
    }
    out.truncate(3);
    out
}

/// 文本 → 具体主题（对应 inferSpecificThemesFromText 的 20 条规则）
fn infer_specific_themes_from_text(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let rules: &[(Regex, &str)] = &[
        (re(r"创新药"), "创新药"),
        (re(r"白酒"), "白酒"),
        (re(r"锂矿|锂业|碳酸锂|锂盐|盐湖提锂"), "锂矿"),
        (
            re(r"半导体材料|半导体设备|芯片设备|半导体材料设备"),
            "半导体设备",
        ),
        (re(r"绿色电力|绿电"), "绿色电力"),
        (re(r"光伏|太阳能"), "光伏"),
        (re(r"储能"), "储能"),
        (re(r"新能源车|智能车|汽车"), "汽车"),
        (re(r"人工智能|算力|AI"), "人工智能"),
        (re(r"军工|国防"), "军工"),
        (re(r"黄金|贵金属"), "黄金"),
        (re(r"消费电子"), "消费电子"),
        (re(r"半导体|芯片|集成电路"), "半导体"),
        (re(r"电力|公用事业"), "电力"),
        (re(r"医药|医疗|生物"), "医药"),
        (re(r"新能源|锂电"), "新能源"),
        (re(r"银行|证券|保险|金融"), "金融"),
        (re(r"地产|房地产"), "地产"),
        (re(r"食品饮料|食品"), "食品饮料"),
        (re(r"煤炭|钢铁|有色"), "周期"),
    ];
    let mut out: Vec<&str> = Vec::new();
    for (r, label) in rules {
        if r.is_match(text) {
            out.push(label);
        }
    }
    let drop_if_finer: &[(&str, &[&str])] = &[
        ("医药", &["创新药"]),
        ("半导体", &["半导体设备"]),
        ("电力", &["绿色电力"]),
        ("新能源", &["锂矿", "光伏", "储能", "绿色电力"]),
        ("周期", &["锂矿"]),
        ("食品饮料", &["白酒"]),
    ];
    let keep: Vec<bool> = out
        .iter()
        .map(|label| {
            let pair = drop_if_finer.iter().find(|(coarse, _)| coarse == label);
            match pair {
                Some((_, finer)) => !finer.iter().any(|f| out.contains(f)),
                None => true,
            }
        })
        .collect();
    out = out
        .into_iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(a, _)| a)
        .collect();
    out.into_iter().map(|s| s.to_string()).collect()
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("regex 编译失败")
}

/// 持仓 → 主题（对应 inferThemesFromHoldings，FundMNInverstPosition + 7 条规则）
async fn infer_themes_from_holdings(code: &str) -> Vec<String> {
    let padded = pad6(code);
    let data = match eastmoney_fund_get(
        "FundMNInverstPosition",
        &HashMap::from([("FCODE".to_string(), padded)]),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let stocks = data
        .get("fundStocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let texts: String = stocks
        .iter()
        .take(10)
        .map(|s| {
            let gpjc = s.get("GPJC").and_then(|v| v.as_str()).unwrap_or("");
            let gpname = s.get("GPNAME").and_then(|v| v.as_str()).unwrap_or("");
            format!("{gpjc} {gpname}")
        })
        .collect::<Vec<_>>()
        .join(" ");
    let etf_name = data
        .get("ETFSHORTNAME")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let hay = format!("{texts} {etf_name}");
    let rules: &[(Regex, &str)] = &[
        (
            re(r"锂|盐湖|赣锋|天齐|雅化|中矿|永兴材料|西藏矿业|西藏珠峰|天华新能|盛新锂能"),
            "锂矿",
        ),
        (
            re(r"创新药|药明|百济|信达|恒瑞|科伦|复星医药|君实|康方"),
            "创新药",
        ),
        (re(r"茅台|五粮液|泸州老窖|汾酒|洋河|白酒"), "白酒"),
        (re(r"宁德时代|比亚迪|理想|小鹏|蔚来|新能源车"), "汽车"),
        (re(r"隆基|通威|阳光电源|晶澳|光伏"), "光伏"),
        (re(r"中芯|韦尔|北方华创|中微|拓荆|半导体|芯片"), "半导体"),
        (re(r"贵州茅台"), "白酒"),
    ];
    let mut votes: HashMap<&str, u32> = HashMap::new();
    for (r, label) in rules {
        if r.is_match(&hay) {
            *votes.entry(label).or_insert(0) += 1;
        }
    }
    let mut sorted: Vec<(&str, u32)> = votes.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted
        .iter()
        .take(2)
        .map(|(label, _)| label.to_string())
        .collect()
}

/// 板块推断主入口（对应 fetchFundSectors）
pub async fn fetch_fund_sectors(code: &str, name_hint: &str) -> Vec<String> {
    fn push_unique(specific: &mut Vec<String>, s: String) {
        let t = s.trim().to_string();
        if !t.is_empty() && !specific.contains(&t) {
            specific.push(t);
        }
    }

    let mut specific: Vec<String> = Vec::new();

    let basic = eastmoney_fund_get(
        "FundMNBasicInformation",
        &HashMap::from([("FCODE".to_string(), pad6(code))]),
    )
    .await
    .ok();

    let short_name = if !name_hint.is_empty() {
        name_hint.to_string()
    } else {
        basic
            .as_ref()
            .and_then(|b| b.get("SHORTNAME").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    };
    let index_name = basic
        .as_ref()
        .and_then(|b| b.get("INDEXNAME").and_then(|v| v.as_str()))
        .filter(|s| *s != "--")
        .unwrap_or("")
        .to_string();

    for t in theme_from_index_name(&index_name) {
        push_unique(&mut specific, t);
    }
    for t in infer_specific_themes_from_text(&format!("{short_name} {index_name}")) {
        push_unique(&mut specific, t);
    }

    if specific.is_empty() {
        for t in infer_themes_from_holdings(code).await {
            push_unique(&mut specific, t);
        }
    } else {
        let from_holdings = infer_themes_from_holdings(code).await;
        for t in from_holdings {
            if !is_coarse(&t) {
                push_unique(&mut specific, t);
            }
        }
    }

    if specific.is_empty() {
        if let Some(b) = &basic {
            if let Some(t) = b.get("TTYPENAME").and_then(|v| v.as_str()) {
                push_unique(&mut specific, t.to_string());
            }
            if let Some(list) = b.get("FUNDSUBJECTLIST").and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(t) = item.get("TTYPENAME").and_then(|v| v.as_str()) {
                        push_unique(&mut specific, t.to_string());
                    }
                }
            }
        }
    }

    finalize_themes(specific)
}

/// 串行队列版（对应 fetchFundSectorsQueued：同一时间只跑一个推断任务）
pub async fn fetch_fund_sectors_queued(code: &str, name_hint: &str) -> Vec<String> {
    static CHAIN: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = CHAIN.get_or_init(|| Mutex::new(())).lock().await;
    fetch_fund_sectors(code, name_hint).await
}
