//! 基金名称归一化与匹配 —— 对应 `packages/core/src/fundName.ts` 1:1 迁移。
//! ⚠️ 绝不能剥离末尾份额字母（A/C/E/I…）：不同份额是不同基金。

/// 全角 → 半角（ＡＢＣ→ABC、１２３→123、全角空格→空格）
fn to_half_width(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '\u{3000}' => ' ',
            _ => c,
        })
        .collect()
}

fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200D}' | '\u{AD}' | '\u{FEFF}')
}

fn is_bracket(c: char) -> bool {
    matches!(
        c,
        '(' | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '【'
            | '】'
            | '《'
            | '》'
            | '<'
            | '>'
            | '「'
            | '」'
            | '『'
            | '』'
    )
}

fn is_separator(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '-'
            | '—'
            | '–'
            | '_'
            | '·'
            | '•'
            | '、'
            | ','
            | '，'
            | '.'
            | '。'
            | ':'
            | '：'
            | ';'
            | '；'
            | '\''
            | '"'
            | '“'
            | '”'
            | '‘'
            | '’'
    )
}

/// 基础归一化（严格匹配用）
pub fn normalize_fund_name(name: Option<&str>) -> String {
    let Some(name) = name else {
        return String::new();
    };
    let s = to_half_width(name.trim());
    let s: String = s.chars().filter(|c| !is_invisible(*c)).collect();
    let s: String = s.chars().filter(|c| !is_bracket(*c)).collect();
    let s: String = s.chars().filter(|c| !is_separator(*c)).collect();
    s.to_uppercase()
}

/// 宽松匹配时剥离的「基金类型/结构」词（按长度降序，份额字母不受影响）
const TYPE_WORDS: &[&str] = &[
    "证券投资基金",
    "集合资产管理计划",
    "ETF联接",
    "ETF发起式联接",
    "交易型开放式指数",
    "定期开放",
    "灵活配置",
    "发起式",
    "混合型",
    "股票型",
    "债券型",
    "指数型",
    "货币型",
    "理财型",
    "FOF",
    "LOF",
    "QDII",
    "发起",
    "联接",
    "混合",
    "股票",
    "债券",
    "指数",
    "货币",
    "理财",
    "基金",
    "型",
];

/// 宽松归一化：剥离基金类型词
pub fn loose_fund_name(name: Option<&str>) -> String {
    let mut s = normalize_fund_name(name);
    if s.is_empty() {
        return s;
    }
    for w in TYPE_WORDS {
        s = s.split(w).collect::<Vec<_>>().join("");
    }
    s
}

/// 严格等价（忽略全半角/空格/括号/大小写）
pub fn is_same_fund_name(a: Option<&str>, b: Option<&str>) -> bool {
    let x = normalize_fund_name(a);
    let y = normalize_fund_name(b);
    !x.is_empty() && !y.is_empty() && x == y
}

/// 宽松等价（再忽略基金类型词）
pub fn is_loose_same_fund_name(a: Option<&str>, b: Option<&str>) -> bool {
    let x = loose_fund_name(a);
    let y = loose_fund_name(b);
    !x.is_empty() && !y.is_empty() && x == y
}

pub type FundNameCandidate = (String, String); // (code, name)

/// 从搜索候选里挑出与 inputName 对应的那一只（严格唯一 → 宽松唯一 → null）
pub fn pick_fund_by_name(
    candidates: &[FundNameCandidate],
    input_name: Option<&str>,
) -> Option<(FundNameCandidate, &'static str)> {
    if candidates.is_empty() {
        return None;
    }
    let strict = normalize_fund_name(input_name);
    if strict.is_empty() {
        return None;
    }
    let exact: Vec<&FundNameCandidate> = candidates
        .iter()
        .filter(|(_, n)| normalize_fund_name(Some(n)) == strict)
        .collect();
    if exact.len() == 1 {
        return Some((exact[0].clone(), "exact"));
    }
    if exact.len() > 1 {
        return None;
    }
    let loose = loose_fund_name(input_name);
    // 宽松名过短（剥离后只剩一两个字）时误配风险高，直接放弃
    if loose.chars().count() < 4 {
        return None;
    }
    let fuzzy: Vec<&FundNameCandidate> = candidates
        .iter()
        .filter(|(_, n)| loose_fund_name(Some(n)) == loose)
        .collect();
    if fuzzy.len() == 1 {
        return Some((fuzzy[0].clone(), "loose"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_matching() {
        assert!(is_same_fund_name(
            Some("嘉实创新先锋混合C"),
            Some("嘉实创新先锋混合C")
        ));
        assert!(is_same_fund_name(
            Some(" 嘉实创新先锋 混合C "),
            Some("嘉实创新先锋混合C")
        ));
        assert!(!is_same_fund_name(
            Some("嘉实创新先锋混合C"),
            Some("嘉实创新先锋混合A")
        ));
    }

    #[test]
    fn loose_matching() {
        assert!(is_loose_same_fund_name(
            Some("嘉实创新先锋C"),
            Some("嘉实创新先锋混合C")
        ));
    }

    #[test]
    fn pick_unique() {
        let cands = vec![
            ("009995".to_string(), "嘉实创新先锋混合C".to_string()),
            ("009994".to_string(), "嘉实创新先锋混合A".to_string()),
            ("000001".to_string(), "华夏成长混合".to_string()),
        ];
        let r = pick_fund_by_name(&cands, Some("嘉实创新先锋C"));
        assert!(r.is_some());
        assert_eq!(r.unwrap().0 .0, "009995");
    }
}
