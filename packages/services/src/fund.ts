import {httpGet, httpPost, MOBILE_UA, fmtDate} from './http'
import {
  isConfirmedSessionActive,
  isLooseSameFundName,
  isSameFundName,
  looseFundName,
  pickFundByName,
  type QuoteSource,
  type ResolveFundResult,
} from '@fund01/core'

// CSRF token 缓存：SW 重启时丢失，会多请求一次 fund123.cn（可接受）
const csrfCache = new Map<string, {token: string; expiresAt: number}>()
const CSRF_KEY = 'fund123-csrf'
const CSRF_TTL = 10 * 60 * 1000

async function getCsrf(): Promise<string | null> {
  const c = csrfCache.get(CSRF_KEY)
  if (c && c.token && Date.now() < c.expiresAt) return c.token
  return null
}

async function setCsrf(token: string): Promise<void> {
  csrfCache.set(CSRF_KEY, {token, expiresAt: Date.now() + CSRF_TTL})
}

async function ensureCsrf(force = false): Promise<string> {
  if (!force) {
    const cached = await getCsrf()
    if (cached) return cached
  }
  const html = await httpGet('https://www.fund123.cn/fund', {
    responseType: 'text',
    headers: {Referer: 'https://www.fund123.cn/'},
    // CSRF 依赖 GET /fund 下发的会话 cookie，必须携带
    credentials: 'include',
  })
  const match = String(html || '').match(/"csrf":"([^"]+)"/)
  if (!match) throw new Error('获取 fund123 CSRF 失败')
  await setCsrf(match[1])
  return match[1]
}

async function fund123Post(path: string, body: any): Promise<any> {
  const run = async (force: boolean) => {
    const csrf = await ensureCsrf(force)
    return httpPost(`https://www.fund123.cn${path}?_csrf=${csrf}`, body, {
      headers: {
        Origin: 'https://www.fund123.cn',
        Referer: 'https://www.fund123.cn/fund',
        'X-API-Key': 'foobar',
      },
      // fund123 接口可能校验会话 cookie，保持 include
      credentials: 'include',
    })
  }
  try {
    return await run(false)
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('403') || msg.includes('401')) {
      // CSRF 可能过期，强制刷新重试一次
      console.warn(`[fund01] fund123Post ${path} 首次失败 (${msg})，刷新 CSRF 重试`)
      try {
        return await run(true)
      } catch (e2: any) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2)
        console.warn(`[fund01] fund123Post ${path} 重试仍失败`, msg2)
        throw e2
      }
    }
    console.warn(`[fund01] fund123Post ${path} 失败`, msg)
    throw e
  }
}

function parsePct(v: any): number | null {
  if (v == null || v === '--' || v === '') return null
  const n = parseFloat(String(v).replace('%', ''))
  return Number.isFinite(n) ? n : null
}

export async function searchFund(code: string) {
  const padded = String(code).padStart(6, '0')
  const data = await fund123Post('/api/fund/searchFund', {fundCode: padded})
  if (!data?.success || !data?.fundInfo) {
    throw new Error(data?.message || `未找到基金 ${padded}`)
  }
  const info = data.fundInfo
  return {
    code: info.fundCode || padded,
    name: info.fundName || padded,
    fundKey: info.key || '',
    netValue: parseFloat(info.netValue) || null,
    dayGrowth: parsePct(info.dayOfGrowth),
  }
}

/**
 * 按关键词（基金名 / 代码 / 拼音简写）搜索基金，返回候选列表。
 *
 * ⚠️ 该接口是**模糊匹配且永远返回结果**的：搜一个根本不存在的名字也会返回
 * 10 条无关基金。因此调用方**绝不能直接取第一条**，必须用
 * `pickFundByName()` 做名称精确过滤。
 */
export async function searchFundsByKeyword(
  keyword: string,
): Promise<{code: string; name: string}[]> {
  const key = String(keyword || '').trim()
  if (!key) return []
  const data = await httpGet(
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx',
    {
      params: {m: 1, key},
      headers: {Referer: 'https://fund.eastmoney.com/'},
      timeout: 12000,
    },
  )
  const rows = Array.isArray(data?.Datas) ? data.Datas : []
  return rows
    .filter((r: any) => r?.CODE && r?.NAME && /^\d{6}$/.test(String(r.CODE)))
    .map((r: any) => ({code: String(r.CODE), name: String(r.NAME)}))
}

/**
 * 用「名称」交叉验证「代码」，必要时按名称反查出正确代码。
 *
 * 背景：AI 从持仓截图识别代码常错一两位（009995→009895），错误代码往往也是
 * 一只真实存在的基金，导入不报错却装错标的。名称是唯一能交叉验证的信息。
 *
 * 不同平台对基金叫法有差异（如 fund123「嘉实低碳精选混合C」vs 天天基金
 * 「嘉实低碳精选混合发起式C」），所以 officialNames 传入**多平台权威名**，
 * 只要用户传入名与其中任一相符（严格或宽松）即视为代码正确，不再误报。
 *
 * 策略（宁缺毋滥，不猜）：
 * - 输入名与任一权威名（严格/宽松）一致 → 直接通过
 * - 不一致 → 按名称搜索；候选里若能唯一确定一只，才纠正代码
 * - 仍无法确定 → 保留原代码，返回 nameMismatch 由上层提示用户
 */
async function verifyCodeByName(
  code: string,
  officialNames: string[],
  inputName?: string,
): Promise<Pick<ResolveFundResult, 'nameMismatch' | 'codeCorrected'> & {code: string}> {
  const input = String(inputName || '').trim()
  // 没传名称 → 无需处理
  if (!input) return {code}
  // 不同平台叫法不同，任一权威名（严格或宽松）与输入名相符即通过，避免误报。
  const matchAny = officialNames.some(
    (n) => !!n && (isSameFundName(input, n) || isLooseSameFundName(input, n)),
  )
  if (matchAny) return {code}

  /**
   * 用给定关键词搜索，并据结果判定当前 code 是否成立：
   * - candidates 里包含当前 code → 叫法差异（官方全称 vs App 简称），代码正确，ok=true
   * - 否则 pickFundByName 唯一命中另一只 → returned.codeCorrected
   * - 否则 → null（交给上层是否再试宽松名 / 告警）
   */
  const searchAndVerify = async (
    keyword: string,
  ): Promise<null | {ok: true} | {ok: false; corrected: NonNullable<ResolveFundResult['codeCorrected']>}> => {
    if (!keyword) return null
    let candidates: {code: string; name: string}[] = []
    try {
      candidates = await searchFundsByKeyword(keyword)
    } catch (e) {
      console.warn('[fund01] verifyCodeByName 搜索失败', {
        code,
        keyword,
        errMsg: e instanceof Error ? e.message : String(e),
      })
      return null
    }
    // 候选里若包含原代码，说明只是叫法差异（官方全称 vs App 简称），代码本身没错
    if (candidates.some((c) => c.code === code)) return {ok: true}
    const picked = pickFundByName(candidates, input)
    if (picked && picked.hit.code !== code) {
      console.warn('[fund01] verifyCodeByName 代码已纠正', {
        from: code,
        to: picked.hit.code,
        keyword,
        inputName: input,
        officialNames,
        matchedBy: picked.matchedBy,
      })
      return {
        ok: false,
        corrected: {
          from: code,
          to: picked.hit.code,
          fromName: officialNames.find((n) => !!n) || '',
          toName: picked.hit.name,
          matchedBy: picked.matchedBy,
        },
      }
    }
    return null
  }

  // 1) 用原始名搜索（最常见路径）
  const r1 = await searchAndVerify(input)
  if (r1 && (r1.ok || r1.corrected)) {
    return r1.ok ? {code} : {code: r1.corrected.to, codeCorrected: r1.corrected}
  }

  // 2) 宽松名兜底：剥离「混合/发起式/股票」等类型词后再搜一次。
  //    消化「嘉实低碳精选混合发起式C」这类多了冗余描述、但实际就是 017037 的情况，
  //    避免 AI 多加一两个类型词就误报「代码与名称对不上」。
  const loose = looseFundName(input)
  if (loose.length >= 4) {
    const r2 = await searchAndVerify(loose)
    if (r2 && (r2.ok || r2.corrected)) {
      return r2.ok ? {code} : {code: r2.corrected.to, codeCorrected: r2.corrected}
    }
  }

  const officials = officialNames.filter((n) => !!n)
  return {code, nameMismatch: {input, officials}}
}

async function eastmoneyFundGet(path: string, params: Record<string, any> = {}) {
  let lastErr: any
  for (let i = 0; i < 3; i++) {
    try {
      const data = await httpGet(`https://fundmobapi.eastmoney.com/FundMNewApi/${path}`, {
        params: {
          deviceid: 'Wap',
          plat: 'Wap',
          product: 'EFund',
          version: '2.0.0',
          appType: 'ttjj',
          _: Date.now(),
          ...params,
        },
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: 'https://fund.eastmoney.com/',
          Origin: 'https://fund.eastmoney.com',
        },
        timeout: 12000,
      })
      if (data?.Success) return data.Datas
      lastErr = new Error(data?.ErrMsg || `${path} 暂不可用`)
      console.warn(`[fund01] fundmobapi ${path} attempt=${i + 1}/3 接口返回失败`, {
        errMsg: data?.ErrMsg,
        errorCode: data?.ErrorCode,
      })
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fundmobapi ${path} attempt=${i + 1}/3 网络异常`, msg)
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)))
  }
  throw lastErr || new Error(`${path} 获取失败`)
}

const COARSE_SECTORS = new Set([
  '有色金属', '化学制药', '医药生物', '食品饮料', '公用事业',
  '通信设备', '元件', '银行', '非银金融', '房地产',
  '电子', '计算机', '机械设备', '基础化工', '混业', '综合',
])

function sectorsNeedRefresh(sectors: string[] | null, name = ''): boolean {
  if (!Array.isArray(sectors) || !sectors.length) return true
  const n = String(name)
  if (sectors.includes('有色金属')) return true
  if (sectors.includes('医药') || sectors.includes('化学制药')) {
    if (/创新药/.test(n)) return true
  }
  if (sectors.includes('半导体') && /半导体材料|半导体设备/.test(n)) return true
  if (sectors.includes('电力') && /绿色电力|绿电/.test(n)) return true
  if (sectors.includes('食品饮料') && /白酒/.test(n)) return true
  return false
}

function themeFromIndexName(indexName = ''): string[] {
  let s = String(indexName || '').trim()
  if (!s || s === '--') return []
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^(中证|国证|沪深|上证|深证|标普|恒生|MSCI|富时|全指)/i, '')
    if (next === s) break
    s = next
  }
  s = s
    .replace(
      /(交易型开放式指数证券投资基金|全收益指数|净收益指数|价格指数|主题指数|产业指数|策略指数|指数)$/g,
      '',
    )
    .replace(/(主题|产业)$/g, '')
    .replace(/[()（）\s]/g, '')
    .trim()
  if (!s || s.length < 2 || s.length > 10) return []
  return [s]
}

function finalizeThemes(list: string[]): string[] {
  let out = [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))]
  out = out.filter((a) => {
    if (a === '半导体' && out.some((x) => x !== a && x.includes('半导体'))) return false
    if (a === '半导体设备' && out.some((x) => x.includes('半导体材料'))) return false
    if (a === '医药' && out.includes('创新药')) return false
    if (a === '电力' && out.includes('绿色电力')) return false
    if (a === '新能源' && out.some((x) => ['锂矿', '光伏', '储能', '绿色电力'].includes(x))) return false
    if (COARSE_SECTORS.has(a) && out.some((x) => !COARSE_SECTORS.has(x))) return false
    return true
  })
  const shorts = out.filter((s) => s.length <= 4)
  if (shorts.length) {
    out = out.filter((s) => !(s.length > 4 && shorts.some((sh) => s !== sh && s.includes(sh))))
  }
  return out.slice(0, 3)
}

function inferSpecificThemesFromText(text = ''): string[] {
  const t = String(text)
  if (!t) return []
  const rules: [RegExp, string][] = [
    [/创新药/, '创新药'],
    [/白酒/, '白酒'],
    [/锂矿|锂业|碳酸锂|锂盐|盐湖提锂/, '锂矿'],
    [/半导体材料|半导体设备|芯片设备|半导体材料设备/, '半导体设备'],
    [/绿色电力|绿电/, '绿色电力'],
    [/光伏|太阳能/, '光伏'],
    [/储能/, '储能'],
    [/新能源车|智能车|汽车/, '汽车'],
    [/人工智能|算力|AI/, '人工智能'],
    [/军工|国防/, '军工'],
    [/黄金|贵金属/, '黄金'],
    [/消费电子/, '消费电子'],
    [/半导体|芯片|集成电路/, '半导体'],
    [/电力|公用事业/, '电力'],
    [/医药|医疗|生物/, '医药'],
    [/新能源|锂电/, '新能源'],
    [/银行|证券|保险|金融/, '金融'],
    [/地产|房地产/, '地产'],
    [/食品饮料|食品/, '食品饮料'],
    [/煤炭|钢铁|有色/, '周期'],
  ]
  const out: string[] = []
  for (const [re, label] of rules) {
    if (re.test(t)) out.push(label)
  }
  const dropIfFiner: [string, string[]][] = [
    ['医药', ['创新药']],
    ['半导体', ['半导体设备']],
    ['电力', ['绿色电力']],
    ['新能源', ['锂矿', '光伏', '储能', '绿色电力']],
    ['周期', ['锂矿']],
    ['食品饮料', ['白酒']],
  ]
  return out.filter((label) => {
    const pair = dropIfFiner.find(([coarse]) => coarse === label)
    if (!pair) return true
    return !pair[1].some((fine) => out.includes(fine))
  })
}

async function inferThemesFromHoldings(code: string): Promise<string[]> {
  try {
    const data = await eastmoneyFundGet('FundMNInverstPosition', {
      FCODE: String(code).padStart(6, '0'),
    })
    const stocks = data?.fundStocks || []
    const texts = stocks
      .slice(0, 10)
      .map((s: any) => `${s.GPJC || ''} ${s.GPNAME || ''}`)
      .join(' ')
    const etfName = data?.ETFSHORTNAME || ''
    const votes = new Map<string, number>()
    const holdingRules: [RegExp, string][] = [
      [/锂|盐湖|赣锋|天齐|雅化|中矿|永兴材料|西藏矿业|西藏珠峰|天华新能|盛新锂能/, '锂矿'],
      [/创新药|药明|百济|信达|恒瑞|科伦|复星医药|君实|康方/, '创新药'],
      [/茅台|五粮液|泸州老窖|汾酒|洋河|白酒/, '白酒'],
      [/宁德时代|比亚迪|理想|小鹏|蔚来|新能源车/, '汽车'],
      [/隆基|通威|阳光电源|晶澳|光伏/, '光伏'],
      [/中芯|韦尔|北方华创|中微|拓荆|半导体|芯片/, '半导体'],
      [/贵州茅台/, '白酒'],
    ]
    const hay = `${texts} ${etfName}`
    for (const [re, label] of holdingRules) {
      if (re.test(hay)) votes.set(label, (votes.get(label) || 0) + 1)
    }
    return [...votes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label)
      .slice(0, 2)
  } catch {
    return []
  }
}

export async function fetchFundSectors(code: string, nameHint = ''): Promise<string[]> {
  const specific: string[] = []
  const pushUnique = (list: string[]) => {
    for (const s of list) {
      const t = String(s || '').trim()
      if (t && !specific.includes(t)) specific.push(t)
    }
  }

  let basic: any = null
  try {
    basic = await eastmoneyFundGet('FundMNBasicInformation', {
      FCODE: String(code).padStart(6, '0'),
    })
  } catch {
    basic = null
  }

  const shortName = nameHint || basic?.SHORTNAME || ''
  const indexName = basic?.INDEXNAME && basic.INDEXNAME !== '--' ? basic.INDEXNAME : ''

  pushUnique(themeFromIndexName(indexName))
  pushUnique(inferSpecificThemesFromText(`${shortName} ${indexName}`))

  if (!specific.length) {
    pushUnique(await inferThemesFromHoldings(code))
  } else {
    const fromHoldings = await inferThemesFromHoldings(code)
    pushUnique(fromHoldings.filter((s) => !COARSE_SECTORS.has(s)))
  }

  if (!specific.length && basic) {
    if (basic.TTYPENAME) pushUnique([basic.TTYPENAME])
    for (const item of basic.FUNDSUBJECTLIST || []) {
      if (item?.TTYPENAME) pushUnique([item.TTYPENAME])
    }
  }

  return finalizeThemes(specific)
}

let sectorChain: Promise<void> = Promise.resolve()
export function fetchFundSectorsQueued(code: string, nameHint = ''): Promise<string[]> {
  const job = sectorChain.then(() => fetchFundSectors(code, nameHint))
  sectorChain = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}

export function normalizeNetValueDate(raw: any, now = new Date()): string {
  const s = String(raw || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const md = s.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!md) return ''
  const month = Number(md[1])
  const day = Number(md[2])
  if (!month || !day) return ''
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (candidate > todayOnly) year -= 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function resolveDisplayPercent(opts: {
  estimateGrowth: number | null
  dayGrowth: number | null
  netValueDate: string
}): {percent: number | null; percentSource: 'confirmed' | 'estimate' | null} {
  const navDay = normalizeNetValueDate(opts.netValueDate)
  const inConfirmSession =
    opts.dayGrowth != null && !!navDay && isConfirmedSessionActive(navDay)
  if (inConfirmSession) {
    return {percent: opts.dayGrowth, percentSource: 'confirmed'}
  }
  if (opts.estimateGrowth != null) {
    return {percent: opts.estimateGrowth, percentSource: 'estimate'}
  }
  if (opts.dayGrowth != null) {
    return {percent: opts.dayGrowth, percentSource: null}
  }
  return {percent: null, percentSource: null}
}

export async function getFundMatiaria(code: string) {
  const padded = String(code).padStart(6, '0')
  const html = await httpGet(`https://www.fund123.cn/matiaria?fundCode=${padded}`, {
    responseType: 'text',
    headers: {Referer: 'https://www.fund123.cn/'},
  })
  const text = String(html || '')
  const dayGrowth = parsePct(text.match(/dayOfGrowth":"([^"]+)/)?.[1])
  const netValue = parseFloat(text.match(/netValue":"([^"]+)/)?.[1] || '')
  const netValueDate = normalizeNetValueDate(text.match(/netValueDate":"([^"]+)/)?.[1] || '')
  const fundName = text.match(/fundName":"([^"]+)/)?.[1]
  return {
    code: padded,
    name: fundName,
    dayGrowth: Number.isFinite(dayGrowth as number) ? dayGrowth : null,
    netValue: Number.isFinite(netValue) ? netValue : null,
    netValueDate,
  }
}

const FUND_RANGE_CALENDAR_DAYS: Record<string, number | null> = {
  '3m': 100,
  '1y': 400,
  '3y': 1200,
  since: null,
}

function round4(n: number): number {
  return Math.round(Number(n) * 10000) / 10000
}

function mapHisNetRows(list: any[]) {
  const rows = Array.isArray(list) ? list : []
  return rows
    .map((r) => {
      const netValue = parseFloat(r.DWJZ)
      const dayGrowth = parsePct(r.JZZZL)
      const date = normalizeNetValueDate(r.FSRQ || '')
      return {date, netValue: Number.isFinite(netValue) ? netValue : null, dayGrowth}
    })
    .filter((r) => r.netValue != null && r.date)
}

export async function fetchFundNavHistory(code: string, pageSize = 5, pageIndex = 1) {
  const list = await eastmoneyFundGet('FundMNHisNetList', {
    FCODE: String(code).padStart(6, '0'),
    pageIndex,
    pageSize,
  })
  return mapHisNetRows(list)
}

async function fetchFundNavHistoryPaged(
  code: string,
  opts: {pageSize?: number; maxPages?: number; minCount?: number} = {},
) {
  const pageSize = opts.pageSize || 500
  const maxPages = opts.maxPages || 1
  const minCount = opts.minCount || 0
  const all: any[] = []
  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const rows = await fetchFundNavHistory(code, pageSize, pageIndex)
    if (!rows.length) break
    all.push(...rows)
    if (rows.length < pageSize) break
    if (minCount > 0 && all.length >= minCount) break
  }
  return all
}

function filterFundNavByRange(
  rowsAsc: {date: string; netValue: number | null}[],
  range: string,
) {
  const days = FUND_RANGE_CALENDAR_DAYS[range]
  if (days == null) return rowsAsc
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days)
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
  return rowsAsc.filter((p) => p.date >= startStr)
}

/**
 * 降采样：点数超过 max 时按比例均匀抽取（保留首尾），控制序列化体积与 echarts 渲染量。
 * since 成立以来一次最多拉 40 页 × 500 = 2 万点，直接塞给前端会占 ~1MB 且渲染卡顿。
 */
function downsamplePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points
  const out: T[] = []
  const step = (points.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)])
  }
  return out
}

export async function getFundHistory(code: string, range = '3m') {
  const padded = String(code || '').padStart(6, '0')
  const key = FUND_RANGE_CALENDAR_DAYS[range] !== undefined ? range : '3m'
  let desc: any[]
  if (key === 'since') {
    // minCount 提前退出：成立以来的净值大多 2000-5000 行，4-10 页即可拿到全量，
    // 老基金才需要继续翻页，避免所有基金都串行拉满 40 页
    desc = await fetchFundNavHistoryPaged(padded, {pageSize: 500, maxPages: 40, minCount: 2000})
  } else if (key === '3y') {
    desc = await fetchFundNavHistoryPaged(padded, {pageSize: 500, maxPages: 3, minCount: 900})
  } else if (key === '1y') {
    desc = await fetchFundNavHistory(padded, 320, 1)
  } else {
    desc = await fetchFundNavHistory(padded, 120, 1)
  }
  if (!desc.length) throw new Error(`暂无基金 ${padded} 历史净值`)
  const asc = filterFundNavByRange([...desc].reverse(), key as string)
  if (!asc.length) throw new Error(`暂无该周期净值数据`)
  const base = asc[0].netValue
  const points = downsamplePoints(
    asc.map((p) => ({
      date: p.date,
      netValue: p.netValue,
      percent:
        base && Number.isFinite(base) ? round4(((p.netValue! - base) / base) * 100) : null,
    })),
    1200,
  )
  const last = points[points.length - 1]
  return {
    code: padded,
    range: key as string,
    periodPercent: last?.percent ?? null,
    points,
  }
}

export async function getFundEstimateIntraday(fundKey: string) {
  if (!fundKey) return {points: [], latest: null}
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86400000)
  const data = await fund123Post('/api/fund/queryFundEstimateIntraday', {
    startTime: fmtDate(today),
    endTime: fmtDate(tomorrow),
    limit: 240,
    productId: fundKey,
    format: true,
    source: 'WEALTHBFFWEB',
  })
  const list = data?.list || []
  const points = list
    .map((p: any) => {
      const t = new Date(p.time)
      const hh = String(t.getHours()).padStart(2, '0')
      const mm = String(t.getMinutes()).padStart(2, '0')
      const growth = parseFloat(p.forecastGrowth)
      return {
        time: `${hh}:${mm}`,
        growth: Number.isFinite(growth) ? growth * 100 : null,
        netValue: parseFloat(p.forecastNetValue) || null,
      }
    })
    .filter((p: any) => p.growth != null)
  const latest = points.length ? points[points.length - 1] : null
  return {points, latest}
}

export async function getFundQuote(fund: {
  code: string
  fundKey?: string
  name?: string
  sectors?: string[]
}) {
  const code = fund.code
  let fundKey = fund.fundKey || ''
  let name = fund.name || ''
  let dayGrowth: number | null = null
  let netValue: number | null = null
  let netValueDate = ''

  try {
    if (!fundKey || !name) {
      const searched = await searchFund(code)
      fundKey = fundKey || searched.fundKey
      name = name || searched.name
      dayGrowth = searched.dayGrowth
      netValue = searched.netValue
    }
  } catch {
    // ignore
  }

  try {
    const m = await getFundMatiaria(code)
    name = name || m.name || code
    dayGrowth = m.dayGrowth ?? dayGrowth
    netValue = m.netValue ?? netValue
    netValueDate = m.netValueDate || ''
  } catch {
    // keep previous
  }

  let estimateGrowth: number | null = null
  let estimateNetValue: number | null = null
  let trend: any[] = []
  try {
    const est = await getFundEstimateIntraday(fundKey)
    estimateGrowth = est.latest?.growth ?? null
    estimateNetValue = est.latest?.netValue ?? null
    trend = est.points
  } catch {
    // no estimate
  }

  let hist: any[] = []
  let histIdx = -1
  try {
    hist = await fetchFundNavHistory(code, 5)
    if (hist.length) {
      const navDay = normalizeNetValueDate(netValueDate)
      histIdx = navDay ? hist.findIndex((h) => h.date === navDay) : 0
      if (histIdx < 0) histIdx = 0
      const match = hist[histIdx]
      if (match?.netValue != null) {
        netValue = match.netValue
        if (match.dayGrowth != null) dayGrowth = match.dayGrowth
        if (match.date) netValueDate = match.date
      }
    }
  } catch {
    hist = []
    histIdx = -1
  }

  const {percent, percentSource} = resolveDisplayPercent({estimateGrowth, dayGrowth, netValueDate})
  const hasEstimate = estimateNetValue != null || estimateGrowth != null

  let prevNetValue: number | null = null
  if (percentSource === 'confirmed') {
    if (histIdx >= 0 && hist[histIdx + 1]?.netValue != null) {
      prevNetValue = hist[histIdx + 1].netValue
    }
  } else if (hasEstimate) {
    if (netValue != null) prevNetValue = netValue
  } else if (histIdx >= 0 && hist[histIdx + 1]?.netValue != null) {
    prevNetValue = hist[histIdx + 1].netValue
  } else if (netValue != null) {
    prevNetValue = netValue
  }

  let sectors = Array.isArray(fund.sectors) ? [...fund.sectors] : []
  if (sectorsNeedRefresh(sectors.length ? sectors : null, name)) {
    try {
      const next = await fetchFundSectorsQueued(code, name)
      if (next.length) sectors = next
    } catch {
      // keep previous
    }
  }

  return {
    code,
    name,
    fundKey,
    dayGrowth,
    estimateGrowth,
    percent,
    percentSource,
    netValue,
    estimateNetValue,
    prevNetValue,
    netValueDate,
    time: trend.length ? trend[trend.length - 1].time : null,
    trend,
    sectors,
  }
}

/**
 * 行情抽象：不同数据源（fund123 / FundMNFInfo）实现该接口，
 * 返回统一的 FundQuote 形状，供 holdingsCalc 计算收益。
 */
export type FundQuoteInput = {
  code: string
  fundKey?: string
  name?: string
  sectors?: string[]
}

export type FundQuote = {
  code: string
  name: string
  fundKey: string
  dayGrowth: number | null
  estimateGrowth: number | null
  percent: number | null
  percentSource: 'confirmed' | 'estimate' | null
  netValue: number | null
  estimateNetValue: number | null
  prevNetValue: number | null
  netValueDate: string
  time: string | null
  trend: {time: string; growth: number | null; netValue?: number | null}[]
  sectors: string[]
  error?: string
  /** true 表示 estimateNetValue/estimateGrowth/percent 来自重仓股加权自算
   *  （非 FundMNFInfo 直接返回）。空窗期（15:00-20:00 GSZ 缺失）时为 true。 */
  useCalc?: boolean
}

export interface FundQuoteProvider {
  readonly id: QuoteSource
  fetchQuotes(funds: FundQuoteInput[]): Promise<FundQuote[]>
}

function emptyQuote(fund: FundQuoteInput, error?: string): FundQuote {
  const code = String(fund.code || '').padStart(6, '0')
  return {
    code,
    name: fund.name || code,
    fundKey: fund.fundKey || '',
    dayGrowth: null,
    estimateGrowth: null,
    percent: null,
    percentSource: null,
    netValue: null,
    estimateNetValue: null,
    prevNetValue: null,
    netValueDate: '',
    time: null,
    trend: [],
    sectors: Array.isArray(fund.sectors) ? [...fund.sectors] : [],
    error,
  }
}

/** 通用并发执行器：把 per-fund 的异步任务按 concurrency 路并发跑，失败转 emptyQuote */
async function runQuotesConcurrent(
  funds: FundQuoteInput[],
  worker: (f: FundQuoteInput) => Promise<FundQuote>,
  concurrency = 4,
): Promise<FundQuote[]> {
  const results: FundQuote[] = []
  for (let i = 0; i < funds.length; i += concurrency) {
    const chunk = funds.slice(i, i + concurrency)
    const settled = await Promise.allSettled(chunk.map((f) => worker(f)))
    settled.forEach((s, idx) => {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        const f = chunk[idx]
        results.push(
          emptyQuote(f, String((s as any).reason?.message || (s as any).reason)),
        )
      }
    })
  }
  return results
}

/** fund123 数据源：复用原有 getFundQuote（fund123 + 东方财富历史净值 + 板块推断） */
class Fund123QuoteProvider implements FundQuoteProvider {
  readonly id: QuoteSource = 'fund123'
  async fetchQuotes(funds: FundQuoteInput[]): Promise<FundQuote[]> {
    return runQuotesConcurrent(funds, (f) => getFundQuote(f))
  }
}

/* ----------------------------- FundMNFInfo 数据源 ----------------------------- */

const MNFINFO_DEVICEID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

/** 批量拉取 FundMNFInfo（最多 200 个/次），返回 code → 原始 item 的映射 */
async function fetchFundMNFInfo(codes: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  if (!codes.length) return out
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200)
    let data: any = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        data = await httpGet('https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo', {
          params: {
            pageIndex: 1,
            pageSize: 200,
            plat: 'Android',
            appType: 'ttjj',
            product: 'EFund',
            Version: '1',
            deviceid: MNFINFO_DEVICEID,
            Fcodes: chunk.join(','),
          },
          // 关键：必须用桌面 UA。东方财富 FundMNFInfo 接口对移动 UA 不返回
          // GSZ 估算值（盘中 + 15:00-20:00 空窗期均无），导致今日估算收益不显示。
          // 参考项目（funds）用浏览器 axios 直发，默认桌面 UA，故能拿到 GSZ。
          // httpGet 默认 UA 即桌面 Chrome UA，这里不覆盖。
          timeout: 12000,
        })
        break
      } catch (e) {
        if (attempt === 1) throw e
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    const list = Array.isArray(data?.Datas) ? data.Datas : []
    for (const item of list) {
      const code = String(item?.FCODE || '').padStart(6, '0')
      if (/^\d{6}$/.test(code)) out.set(code, item)
    }
  }
  return out
}

/* ----------------------------- 自算估值 (useCalc fallback) ----------------------------- */
// 15:00 收盘后 ~ 20:00 官方净值披露前（空窗期），FundMNFInfo 停止返回 GSZ/GZTIME。
// 参考线上版 getCalcGszzl / calcFundEstimateChange：用 FundMNInverstPosition 拿前十大
// 重仓股（GPDM=股票代码、NEWTEXCH=市场、JZBL=持仓占比），再调
// push2.eastmoney.com/api/qt/ulist.np/get 取每只股票当日涨跌幅（f3），按持仓占比加权
// 得到基金整体估算涨跌幅。联接基金无直接持仓时取 ETFCODE 再查对应 ETF 的重仓股。
// 精度取决于重仓股覆盖率（通常前十大占 50%~80%），结果为"比较准确"但不完全精确。

/**
 * 通用 TTL 缓存：set 时顺带清理过期项，超出 maxSize 淘汰最早插入的条目，
 * 避免模块级 Map 在 SW 活跃期间无界增长（alarm 每 30-60s 唤醒，SW 可能长期不睡）。
 */
class TtlCache<V> {
  private readonly map = new Map<string, {value: V; expiresAt: number}>()
  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: V): void {
    const now = Date.now()
    // 写入前清理过期项，保证 Map 内只保留有效条目
    for (const [k, e] of this.map) {
      if (now >= e.expiresAt) this.map.delete(k)
    }
    this.map.set(key, {value, expiresAt: now + this.ttlMs})
    // 超上限：淘汰最早插入的条目（Map 迭代序 = 插入序）
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

// 持仓按季度更新，缓存 1 小时足够；上限 200 只（自选/持仓合计常见规模）
const HOLDINGS_CACHE = new TtlCache<any[]>(200, 60 * 60 * 1000)

async function fetchFundTopHoldings(code: string): Promise<any[]> {
  const cached = HOLDINGS_CACHE.get(code)
  if (cached) return cached
  const data = await eastmoneyFundGet('FundMNInverstPosition', {
    FCODE: String(code).padStart(6, '0'),
  })
  let stocks = Array.isArray(data?.fundStocks) ? data.fundStocks : []
  // 联接基金无直接持仓：取 ETFCODE 再查对应 ETF 的重仓股
  if (!stocks.length && data?.ETFCODE) {
    const etfData = await eastmoneyFundGet('FundMNInverstPosition', {
      FCODE: String(data.ETFCODE).padStart(6, '0'),
    })
    stocks = Array.isArray(etfData?.fundStocks) ? etfData.fundStocks : []
  }
  HOLDINGS_CACHE.set(code, stocks)
  return stocks
}

// 股票涨跌幅 30s 缓存：空窗期多次自算共享一次 push2 请求，降低请求量
const STOCK_PCT_CACHE = new TtlCache<Map<string, number>>(32, 30 * 1000)

async function fetchStockPctChanges(secids: string[]): Promise<Map<string, number>> {
  const cacheKey = secids.slice().sort().join(',')
  const cached = STOCK_PCT_CACHE.get(cacheKey)
  if (cached) return cached
  const out = new Map<string, number>()
  if (!secids.length) return out
  const data = await httpGet('https://push2.eastmoney.com/api/qt/ulist.np/get', {
    params: {
      fields: 'f1,f2,f3,f4,f12,f13,f14,f292',
      fltt: 2,
      secids: secids.join(','),
    },
    headers: {Referer: 'https://quote.eastmoney.com/'},
    timeout: 12000,
  })
  const diff = Array.isArray(data?.data?.diff) ? data.data.diff : []
  for (const row of diff) {
    const raw = row?.f3
    const pct = typeof raw === 'number' ? raw : parseFloat(raw)
    if (!Number.isFinite(pct)) continue
    // 同时以 "market.code" 与 "code" 两种 key 存，便于按 NEWTEXCH.GPDM 反查
    if (row?.f13 != null && row?.f12) out.set(`${row.f13}.${row.f12}`, pct)
    if (row?.f12) out.set(String(row.f12), pct)
  }
  STOCK_PCT_CACHE.set(cacheKey, out)
  return out
}

/** 计算基金自算估算涨跌幅：Σ(股票涨跌幅 × 该股占比 / 总占比)。
 *  与线上版 calcFundEstimateChange 一致。返回百分比数值（如 1.23）或 null。 */
function calcFundEstimateChange(
  stocks: any[],
  quoteBySecid: Map<string, number>,
): number | null {
  let totalWeight = 0
  for (const s of stocks) {
    const w = parseFloat(s?.JZBL)
    if (Number.isFinite(w) && w > 0) totalWeight += w
  }
  if (totalWeight <= 0) return null
  let weighted = 0
  let matched = 0
  for (const s of stocks) {
    const w = parseFloat(s?.JZBL)
    if (!Number.isFinite(w) || w <= 0) continue
    const secid = s?.NEWTEXCH && s?.GPDM ? `${s.NEWTEXCH}.${s.GPDM}` : ''
    let pct: number | undefined
    if (secid) pct = quoteBySecid.get(secid)
    if (pct == null && s?.GPDM) pct = quoteBySecid.get(String(s.GPDM))
    if (pct == null || !Number.isFinite(pct)) continue
    weighted += (w / totalWeight) * pct
    matched++
  }
  if (matched === 0) return null
  return Number.isFinite(weighted) ? Math.round(weighted * 100) / 100 : null
}

/** 自算估值主入口（对应线上版 getCalcGszzl）。
 *  返回 calcGszzl（百分比数值，如 1.23）或 null（失败/无持仓/无行情）。
 *
 *  结果缓存 5 分钟：A 股 15:00 收盘后股票价格不再变动，calcGszzl 在空窗期内稳定；
 *  官方净值披露后由 FundMNFInfo 返回 hasReplace=true 触发，上层不再调用本函数，
 *  因此缓存不会导致过期估值覆盖确认净值。
 *  返回 null 时不缓存，便于下次重试。 */
const CALC_GSZZL_CACHE = new TtlCache<number>(200, 5 * 60 * 1000)

export async function getCalcGszzl(code: string): Promise<number | null> {
  const padded = String(code).padStart(6, '0')
  const cached = CALC_GSZZL_CACHE.get(padded)
  if (cached != null) return cached
  try {
    const stocks = await fetchFundTopHoldings(padded)
    if (!stocks.length) return null
    const secids = stocks
      .map((s) => (s?.NEWTEXCH && s?.GPDM ? `${s.NEWTEXCH}.${s.GPDM}` : null))
      .filter((x): x is string => !!x)
    if (!secids.length) return null
    const quoteMap = await fetchStockPctChanges(secids)
    const value = calcFundEstimateChange(stocks, quoteMap)
    if (value != null) {
      CALC_GSZZL_CACHE.set(padded, value)
    }
    return value
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[fund01] getCalcGszzl 失败 code=${padded}`, msg)
    return null
  }
}

/** QDII 基金名判断：证监会规定 QDII 基金名称必须含 "QDII"（兼容全角括号）。
 *  用于自算估值失败时跳过 fund123 fallback —— fund123 对 QDII 无分时估值
 *  （实测 queryFundEstimateIntraday 0 点），且其资料接口会把 T+1 披露的
 *  昨日涨幅冒充今日涨幅，混入会误导；QDII 的可靠估值只来自 FundMNFInfo
 *  链路（盘中 GSZ 正确；空窗期如实无估值，等 T+1 净值确认）。 */
function isQdiiName(name: string): boolean {
  return /QDII/i.test(String(name || ''))
}

/** fund123 分时估值兜底：自算估值失败（无股票重仓）时，用该基金在蚂蚁基金的
 *  官方分时估值（queryFundEstimateIntraday 末点）补估算净值与涨幅。
 *  返回 {growth(%), netValue}；fundKey 缺失时用 searchFund 补查；失败返回 null。
 *  ⚠️ 仅限非 QDII 基金调用（QDII 由调用方用 isQdiiName 过滤）。 */
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

/** 解析单条 FundMNFInfo item 为标准化的行情字段。
 *  当日收益公式（与参考实现一致）：(今日净值 − 昨日净值) × 份额
 *
 *  三种口径（按优先级）：
 *  1. hasReplace（PDATE == GZTIME 日期，即当日净值已披露）：今日=NAV，昨日=NAV/(1+NAVCHGRT%)，
 *     涨幅=NAVCHGRT。此时 GSZ 即使存在也已是冗余/过期，必须用确认净值，否则
 *     prevNetValue 会被设成今日 NAV，导致 pnl ≈ 0（盘中实时收益不显示）。
 *  2. 有 GSZ 且未过期（盘中估算，当日净值未披露）：今日=GSZ，昨日=NAV，涨幅=GSZZL。
 *  3. 空窗期/估值过期（hasReplace=false 且（GSZ 缺失 或 GZTIME 日 < PDATE 日））：
 *     15:00 收盘后 ~ 20:00 官方净值披露前，API 返回 GSZ=null/GZTIME=null；
 *     或 GSZ 存在但估值日期早于净值日期（过期）。此时仅记录 netValue（=昨日 NAV），
 *     不设置 confirmed/percent/dayGrowth/estimate，避免把昨日 NAVCHGRT 冒充今日涨幅。
 *     标记 useCalcNeeded=true，由上层 FundMNFInfoQuoteProvider 调 getCalcGszzl 用
 *     重仓股 + 股票涨跌幅自算估算（参考线上版 getCalcGszzl / calcFundEstimateChange）。
 *     自算失败时由 background 的 mergeStaleEstimate 从上次缓存恢复今日 15:00 最后估算。
 */
function parseFundMNFInfoItem(item: any): {
  name: string
  confirmed: boolean
  dayGrowth: number | null
  estimateGrowth: number | null
  netValue: number | null
  estimateNetValue: number | null
  prevNetValue: number | null
  netValueDate: string
  time: string | null
  /** 空窗期/估值过期：需调 getCalcGszzl 自算估值 */
  useCalcNeeded: boolean
} {
  const nav = parseFloat(item?.NAV)
  const navChgRt = parseFloat(item?.NAVCHGRT)
  const gsz = parseFloat(item?.GSZ)
  const gszzl = parseFloat(item?.GSZZL)
  const pdate = String(item?.PDATE || '')
  const gztime = String(item?.GZTIME || '')

  const navValid = Number.isFinite(nav) && nav > 0
  const navChgRtValid = Number.isFinite(navChgRt)
  const gszValid = Number.isFinite(gsz) && gsz > 0
  const gszzlValid = Number.isFinite(gszzl)

  // hasReplace：当日净值已披露（净值日期 == 估值日期）。
  // 参考实现：if (val.PDATE != "--" && val.PDATE == val.GZTIME.substr(0, 10)) { hasReplace = true }
  const gztimeDay = gztime.length >= 10 ? gztime.slice(0, 10) : ''
  const hasReplace =
    pdate !== '--' && pdate !== '' && gztimeDay !== '' && pdate === gztimeDay

  // 估值过期：GZTIME 日期 < PDATE 日期（线上版 numDate(gztime) < numDate(jzrq)）
  const estimateStale =
    gztimeDay !== '' && pdate !== '' && pdate !== '--' && gztimeDay < pdate

  let netValue: number | null = null
  let prevNetValue: number | null = null
  let estimateNetValue: number | null = null
  let dayGrowth: number | null = null
  let estimateGrowth: number | null = null
  let confirmed = false
  let useCalcNeeded = false

  if (hasReplace) {
    // 当日净值已披露：今日 = NAV，昨日 = NAV / (1 + NAVCHGRT%)，涨幅 = NAVCHGRT。
    // GSZ 即使存在也不再使用（确认净值比估算更准）。
    confirmed = true
    netValue = navValid ? nav : null
    if (navValid && navChgRtValid) {
      prevNetValue = round4(nav / (1 + navChgRt / 100))
    }
    dayGrowth = navChgRtValid ? navChgRt : null
  } else if (gszValid && !estimateStale) {
    // 盘中估算期（估值未过期）：NAV = 昨日确认净值（基准），GSZ = 今日估算净值
    netValue = navValid ? nav : null
    prevNetValue = navValid ? nav : null
    estimateNetValue = gszValid ? gsz : null
    estimateGrowth = gszzlValid ? gszzl : null
  } else {
    // 空窗期（GSZ 缺失）或估值过期（GZTIME < PDATE）：
    // FundMNFInfo 不再提供有效盘中估算。标记 useCalcNeeded，由上层自算估值。
    // 仅记录 netValue（供净值日期展示），其余留空。
    useCalcNeeded = true
    netValue = navValid ? nav : null
  }

  const result = {
    name: String(item?.SHORTNAME || ''),
    confirmed,
    dayGrowth,
    estimateGrowth,
    netValue,
    estimateNetValue,
    prevNetValue,
    netValueDate: pdate && pdate !== '--' ? normalizeNetValueDate(pdate) : '',
    time: gztime && gztime.length >= 16 ? gztime.slice(11, 16) : null,
    useCalcNeeded,
  }
  return result
}

/**
 * FundMNFInfo 数据源：东方财富批量接口提供净值/估值/涨跌幅；
 * 分时走势（盘中曲线）仍走 fund123（getFundEstimateIntraday）。
 */
class FundMNFInfoQuoteProvider implements FundQuoteProvider {
  readonly id: QuoteSource = 'fundmnfinfo'

  async fetchQuotes(funds: FundQuoteInput[]): Promise<FundQuote[]> {
    if (!funds.length) return []

    // 1. 批量拉取 FundMNFInfo 行情（1 次请求最多 200 个）
    let infoMap = new Map<string, any>()
    try {
      const codes = funds.map((f) => String(f.code).padStart(6, '0'))
      infoMap = await fetchFundMNFInfo(codes)
    } catch {
      // 整体失败：仍尝试 per-fund 兜底（searchFund + 走势）
    }

    // 2. 并发补充：板块刷新（分时走势由 FundTrendDialog 懒加载）
    return runQuotesConcurrent(funds, (f) => this.fetchOne(f, infoMap))
  }

  private async fetchOne(
    fund: FundQuoteInput,
    infoMap: Map<string, any>,
  ): Promise<FundQuote> {
    const code = String(fund.code).padStart(6, '0')
    const info = infoMap.get(code)

    let name = fund.name || ''
    let confirmed = false
    let dayGrowth: number | null = null
    let estimateGrowth: number | null = null
    let netValue: number | null = null
    let estimateNetValue: number | null = null
    let prevNetValue: number | null = null
    let netValueDate = ''
    let mnfTime: string | null = null
    let useCalcNeeded = false

    if (info) {
      const p = parseFundMNFInfoItem(info)
      name = name || p.name
      confirmed = p.confirmed
      dayGrowth = p.dayGrowth
      estimateGrowth = p.estimateGrowth
      netValue = p.netValue
      estimateNetValue = p.estimateNetValue
      prevNetValue = p.prevNetValue
      netValueDate = p.netValueDate
      mnfTime = p.time
      useCalcNeeded = p.useCalcNeeded
    }

    // FundMNFInfo 已批量提供估值/涨跌幅/净值，刷新时不调用 fund123。
    // 分时走势曲线（trend）留空，由 FundTrendDialog 懒加载。
    const trend: FundQuote['trend'] = []

    // 直接按 API 文档的确认标志决定展示口径，不走 resolveDisplayPercent
    // （后者基于交易日历，与 PDATE/GZTIME 可能不一致，导致估算期误判为确认期）
    let percent: number | null = null
    let percentSource: 'confirmed' | 'estimate' | null = null
    if (confirmed) {
      // 确认期：当日涨幅 = NAVCHGRT
      if (dayGrowth != null) {
        percent = dayGrowth
        percentSource = 'confirmed'
      }
    } else {
      // 估算期：当日涨幅 = GSZZL；GSZ 缺失时不回退到 NAVCHGRT（那是昨日涨幅）
      if (estimateGrowth != null) {
        percent = estimateGrowth
        percentSource = 'estimate'
      }
    }

    // 自算估值 fallback（参考线上版 useCalc / getCalcGszzl）：
    // 空窗期（15:00 后 ~ 20:00 前GSZ 缺失）或估值过期（GZTIME < PDATE）时，
    // FundMNFInfo 不再返回有效盘中估算。此时用前十大重仓股的当日涨跌幅加权自算
    // 估算涨跌幅，覆盖空的 estimate 字段；calcGsz = NAV × (1 + calcGszzl%)。
    // 自算失败（无持仓/无行情/请求失败）时保持空，由 background 的
    // mergeStaleEstimate 从上次缓存恢复今日 15:00 最后估算。
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
      } else if (isQdiiName(name)) {
        // QDII 跳过 fund123 fallback：fund123 对 QDII 无分时估值（实测 0 点），
        // 且其资料接口会把 T+1 披露的昨日涨幅冒充今日涨幅，混入会误导。
        // 保持 FundMNFInfo 原始口径：盘中 GSZ 正确；空窗期如实无估值，等 T+1 净值确认。
        console.warn(
          `[fund01] FundMNFInfo 自算失败 code=${code} name=${name} —— QDII 跳过 fund123 fallback（fund123 对 QDII 无可靠当日估值）`,
        )
      } else {
        // 自算失败（无重仓股可加权：黄金/商品等）→ fallback fund123 官方分时估值
        const est = await fund123EstimateFallback(code, fund.fundKey)
        if (est) {
          estimateGrowth = est.growth
          estimateNetValue = est.netValue
          percent = est.growth
          percentSource = 'estimate'
          useCalc = true
          console.warn(
            `[fund01] FundMNFInfo 自算失败→fund123 兜底成功 code=${code} growth=${est.growth} est_net=${est.netValue}`,
          )
        }
      }
    }

    // 板块推断（与 fund123 数据源一致，走东方财富持仓 + 基金信息）
    let sectors = Array.isArray(fund.sectors) ? [...fund.sectors] : []
    if (sectorsNeedRefresh(sectors.length ? sectors : null, name)) {
      try {
        const next = await fetchFundSectorsQueued(code, name)
        if (next.length) sectors = next
      } catch {
        // keep previous
      }
    }

    const quote: FundQuote = {
      code,
      name: name || code,
      fundKey: '',
      dayGrowth,
      estimateGrowth,
      percent,
      percentSource,
      netValue,
      estimateNetValue,
      prevNetValue,
      netValueDate,
      time: mnfTime,
      trend,
      sectors,
      useCalc,
    }
    return quote
  }
}

/**
 * 懒加载盘中分时走势（FundMNFInfo 数据源 / 打开 FundTrendDialog 时调用）。
 * fundKey 缺失时用 searchFund 兜底获取；返回曲线点 + fundKey（便于复用）。
 */
export async function fetchFundIntradayForDialog(
  code: string,
  fundKey?: string,
  name?: string,
): Promise<{
  points: {time: string; growth: number | null; netValue?: number | null}[]
  latest: {time: string; growth: number | null; netValue?: number | null} | null
  fundKey: string
  name: string
}> {
  const padded = String(code).padStart(6, '0')
  let key = fundKey || ''
  let resolvedName = name || ''
  if (!key) {
    try {
      const searched = await searchFund(padded)
      key = searched.fundKey || ''
      resolvedName = resolvedName || searched.name
    } catch {
      // ignore
    }
  }
  const est = await getFundEstimateIntraday(key)
  return {
    points: est.points,
    latest: est.latest,
    fundKey: key,
    name: resolvedName,
  }
}

export function getQuoteProvider(source: QuoteSource): FundQuoteProvider {
  return source === 'fundmnfinfo'
    ? new FundMNFInfoQuoteProvider()
    : new Fund123QuoteProvider()
}

export async function getFundsQuotes(
  funds: any[],
  source: QuoteSource = 'fundmnfinfo',
): Promise<FundQuote[]> {
  const provider = getQuoteProvider(source)
  const inputs: FundQuoteInput[] = funds.map((f) => ({
    code: f.code,
    fundKey: f.fundKey,
    name: f.name,
    sectors: f.sectors,
  }))
  return provider.fetchQuotes(inputs)
}

export async function resolveFund(payload: {
  code: string
  type?: 'hold' | 'watch'
  name?: string
  sectors?: string[]
}) {
  let code = String(payload.code || '').trim()
  let meta: any = {}
  try {
    meta = await searchFund(code)
    console.log('[fund01] resolveFund searchFund OK', {
      code,
      metaCode: meta.code,
      metaName: meta.name,
      metaFundKey: meta.fundKey,
      metaNetValue: meta.netValue,
    })
  } catch (e: any) {
    console.warn('[fund01] resolveFund searchFund 失败', {
      code,
      errName: e?.name,
      errMsg: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    if (!payload.name) throw e
  }

  // 代码 ↔ 名称交叉验证。必须在拉板块/净值之前完成，
  // 否则纠正后的代码拿不到对应数据（会混入错误基金的净值）。
  let nameMismatch: ResolveFundResult['nameMismatch']
  let codeCorrected: ResolveFundResult['codeCorrected']

  // 收集多平台权威名（不同平台叫法不同，任一相符即可通过）：
  //  - fund123 /api/fund/searchFund → fundInfo.fundName
  //  - 东方财富 FundMNFInfo → SHORTNAME
  // fund123 不可用时仍有 eastmoney 兜底；只在校验有需要时（传了 name）才发起，
  // 人工手输代码（无 name）路径不额外请求，避免无谓网络开销。
  const collectOfficialNames = async (c: string): Promise<string[]> => {
    const names: string[] = []
    if (meta.name) names.push(meta.name)
    try {
      const mnf = await fetchFundMNFInfo([String(c).padStart(6, '0')])
      const item = mnf.get(String(c).padStart(6, '0'))
      const sn = item?.SHORTNAME
      if (sn) names.push(String(sn))
    } catch (e) {
      console.warn('[fund01] resolveFund 取 FundMNFInfo 名称失败', {
        code: c,
        errMsg: e instanceof Error ? e.message : String(e),
      })
    }
    return names
  }

  if (payload.name) {
    const officialNames = await collectOfficialNames(meta.code || code)
    const verified = await verifyCodeByName(meta.code || code, officialNames, payload.name)
    nameMismatch = verified.nameMismatch
    codeCorrected = verified.codeCorrected
    if (verified.code !== (meta.code || code)) {
      code = verified.code
      // 代码变了，必须用新代码重新取一次元信息（fundKey/净值都会不同）
      try {
        meta = await searchFund(code)
      } catch (e) {
        console.warn('[fund01] resolveFund 纠正代码后重查失败', {
          code,
          errMsg: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }
  const officialName: string = meta.name || ''

  let sectors = Array.isArray(payload.sectors) ? payload.sectors : null
  if (!sectors?.length) {
    try {
      sectors = await fetchFundSectorsQueued(meta.code || code, officialName || payload.name)
    } catch (e) {
      console.warn('[fund01] resolveFund fetchFundSectorsQueued 失败', {
        code,
        errName: e instanceof Error ? e.name : String(e),
        errMsg: e instanceof Error ? e.message : String(e),
      })
      sectors = []
    }
  }

  let netValue: number | null = null
  let prevNetValue: number | null = null
  let prevNetValueDate = ''
  let netValueDate = ''
  if ((payload.type || 'watch') === 'hold') {
    const histCode = meta.code || code
    try {
      const hist = await fetchFundNavHistory(histCode, 5)
      console.log('[fund01] resolveFund fetchFundNavHistory OK', {
        code: histCode,
        histCount: hist?.length || 0,
        hist0: hist?.[0],
        hist1: hist?.[1],
      })
      if (hist.length) {
        netValue = hist[0].netValue
        netValueDate = hist[0].date || ''
        if (hist[1]?.netValue != null) prevNetValue = hist[1].netValue
        if (hist[1]?.date) prevNetValueDate = hist[1].date
      }
    } catch (e) {
      // 关键：之前这里静默吞错导致「暂无确认净值」无法定位根因，现打开日志
      console.warn('[fund01] resolveFund fetchFundNavHistory 失败', {
        code: histCode,
        errName: e instanceof Error ? e.name : String(e),
        errMsg: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      })
    }
  }

  console.log('[fund01] resolveFund 返回', {
    code,
    netValue,
    prevNetValue,
    netValueDate,
    confirmedSession: isConfirmedSessionActive(netValueDate),
  })

  return {
    code: meta.code || code,
    // 关键：官方名优先。以前是 payload.name 优先，导致「代码错、名字对」时
    // 界面显示的是用户给的正确名字、数据却来自另一只基金，错配完全不可见。
    name: officialName || payload.name || code,
    fundKey: meta.fundKey || '',
    sectors: sectors || [],
    netValue: netValue ?? null,
    prevNetValue: prevNetValue ?? null,
    prevNetValueDate,
    netValueDate,
    confirmedSession: isConfirmedSessionActive(netValueDate),
    officialName: officialName || undefined,
    nameMismatch,
    codeCorrected,
  }
}
