/**
 * 基金名称归一化与匹配（纯函数、零依赖，chrome / tauri 共用）。
 *
 * 存在的意义：AI（豆包等）从持仓截图识别出的基金代码常有一两位数字错误，
 * 例如 009995「嘉实创新先锋混合C」被识别成 009895「摩根瑞盛87个月定期开放债券」。
 * 代码合法且能查到基金，导入不会报错，但装的是另一只完全不相干的基金。
 * 名称是唯一能交叉验证代码的信息，这里提供匹配所需的归一化规则。
 *
 * ⚠️ 绝对不能剥离末尾的份额字母（A/C/E/I…）：
 * 「嘉实创新先锋混合A」=009994、「…混合C」=009995 是两只不同的基金。
 */

/** 全角字符 → 半角（ＡＢＣ→ABC、１２３→123） */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/**
 * 不可见分隔符：\s 之外的隐形字符（零宽空格/连字符、软连字符、BOM）。
 * 某些平台导出的基金名会夹带，表现为「有的名称中间有空格有的没空格」，
 * 导致严格/宽松匹配都因隐形字符对不上。归一化时一律清掉。
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\u00AD\uFEFF]/g

/**
 * 基础归一化：去首尾空白与不可见字符、全角转半角、去括号与各类分隔符、英文统一大写。
 * 保留中文主体与份额字母，用于「严格匹配」。
 *
 * ⚠️ 先 `.trim()` 再 `toHalfWidth` 之后的不可见字符清理，确保「中间有空格 /
 * 零宽字符」这类差异在比较前被消除。
 */
export function normalizeFundName(name?: string | null): string {
  if (!name) return ''
  return toHalfWidth(String(name).trim())
    .replace(INVISIBLE_CHARS, '')
    .replace(/[()[\]{}【】《》<>「」『』]/g, '')
    .replace(/[\s\-—–_·•、,，.。:：;；'"'"]/g, '')
    .toUpperCase()
}

/**
 * 需要在宽松匹配时剥离的「基金类型/结构」词。
 * 按长度降序排列，确保「混合型」先于「混合」被吃掉。
 * 注意：这里刻意不含任何单字母，份额标识不受影响。
 */
const TYPE_WORDS = [
  '证券投资基金',
  '集合资产管理计划',
  'ETF联接',
  'ETF发起式联接',
  '交易型开放式指数',
  '定期开放',
  '灵活配置',
  '发起式',
  '混合型',
  '股票型',
  '债券型',
  '指数型',
  '货币型',
  '理财型',
  'FOF',
  'LOF',
  'QDII',
  '发起',
  '联接',
  '混合',
  '股票',
  '债券',
  '指数',
  '货币',
  '理财',
  '基金',
  '型',
]

/**
 * 宽松归一化：在基础归一化之上剥离基金类型词。
 * 用于兼容各 App 的简称差异，例如支付宝「嘉实创新先锋C」
 * 对应天天基金官方名「嘉实创新先锋混合C」。
 *
 * 因为丢失了信息，宽松匹配**必须**要求候选中唯一命中才可采纳。
 */
export function looseFundName(name?: string | null): string {
  let s = normalizeFundName(name)
  if (!s) return ''
  for (const w of TYPE_WORDS) s = s.split(w).join('')
  return s
}

/** 两个基金名是否严格等价（忽略全半角/空格/括号/大小写差异） */
export function isSameFundName(a?: string | null, b?: string | null): boolean {
  const x = normalizeFundName(a)
  const y = normalizeFundName(b)
  return !!x && !!y && x === y
}

/** 两个基金名是否宽松等价（在严格基础上再忽略基金类型词） */
export function isLooseSameFundName(a?: string | null, b?: string | null): boolean {
  const x = looseFundName(a)
  const y = looseFundName(b)
  return !!x && !!y && x === y
}

export type FundNameCandidate = {code: string; name: string}

/**
 * 从搜索候选里挑出与 inputName 对应的那一只。
 *
 * 天天基金的搜索接口是**模糊匹配、永远返回结果**（搜不存在的名字也会返回 10 条
 * 无关基金），所以绝不能取第一条 —— 必须靠名称精确过滤，且宁缺毋滥：
 * - 严格匹配命中唯一 → 采纳（最可信）
 * - 严格匹配命中多条 → 判定歧义，放弃（不猜）
 * - 严格无命中、宽松命中唯一 → 采纳（覆盖各 App 简称差异）
 * - 其余 → 返回 null，只告警不改数据
 */
export function pickFundByName<T extends FundNameCandidate>(
  candidates: T[] | null | undefined,
  inputName?: string | null,
): {hit: T; matchedBy: 'exact' | 'loose'} | null {
  if (!candidates?.length) return null

  const strict = normalizeFundName(inputName)
  if (!strict) return null
  const exact = candidates.filter((c) => normalizeFundName(c.name) === strict)
  if (exact.length === 1) return {hit: exact[0], matchedBy: 'exact'}
  if (exact.length > 1) return null

  const loose = looseFundName(inputName)
  // 宽松名过短（如剥离后只剩一两个字）时误配风险高，直接放弃
  if (loose.length < 4) return null
  const fuzzy = candidates.filter((c) => looseFundName(c.name) === loose)
  if (fuzzy.length === 1) return {hit: fuzzy[0], matchedBy: 'loose'}
  return null
}
