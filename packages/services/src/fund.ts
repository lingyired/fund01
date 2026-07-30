import {httpGet, httpPost, MOBILE_UA, fmtDate} from './http'
import {isConfirmedSessionActive, type QuoteSource} from '@fund01/core'

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
    })
  }
  try {
    return await run(false)
  } catch (e: any) {
    if (e.message?.includes('403') || e.message?.includes('401')) {
      return run(true)
    }
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
    } catch (e) {
      lastErr = e
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

export async function getFundHistory(code: string, range = '3m') {
  const padded = String(code || '').padStart(6, '0')
  const key = FUND_RANGE_CALENDAR_DAYS[range] !== undefined ? range : '3m'
  let desc: any[]
  if (key === 'since') {
    desc = await fetchFundNavHistoryPaged(padded, {pageSize: 500, maxPages: 40})
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
  const points = asc.map((p) => ({
    date: p.date,
    netValue: p.netValue,
    percent:
      base && Number.isFinite(base) ? round4(((p.netValue! - base) / base) * 100) : null,
  }))
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
          headers: {
            'User-Agent': MOBILE_UA,
            Referer: 'https://fund.eastmoney.com/',
          },
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

/** 解析单条 FundMNFInfo item 为标准化的行情字段。
 *  当日收益公式（与参考实现一致）：(今日净值 − 昨日净值) × 份额
 *  - 有 GSZ（盘中估算）：今日=GSZ，昨日=NAV，涨幅=GSZZL
 *  - 无 GSZ 但有 NAVCHGRT（净值已确认 / 今日未公布）：今日=NAV，昨日=NAV/(1+NAVCHGRT%)，涨幅=NAVCHGRT
 *    收益对应日期 = PDATE（可能为昨日，由 UI 标注）
 *
 *  注意：API 文档的「PDATE == GZTIME 日期」判断在 GZTIME 为 null（非盘中）时失效。
 *  参考实现用「是否有 GSZ」区分：有估算用估算，无估算即按 NAV + NAVCHGRT 反推昨日净值。
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

  // 有估算净值 → 估算期；无估算净值但有 NAVCHGRT → 确认期（按 NAV + 涨幅反推昨日净值）
  const confirmed = !gszValid && navChgRtValid

  let netValue: number | null = null
  let prevNetValue: number | null = null
  let estimateNetValue: number | null = null
  let dayGrowth: number | null = null
  let estimateGrowth: number | null = null

  if (gszValid) {
    // 估算期：NAV = 昨日确认净值（基准），GSZ = 今日估算净值
    netValue = navValid ? nav : null
    prevNetValue = navValid ? nav : null
    estimateNetValue = gszValid ? gsz : null
    estimateGrowth = gszzlValid ? gszzl : null
  } else if (confirmed) {
    // 确认期：NAV = 最新确认净值，昨日净值 = NAV / (1 + NAVCHGRT%)
    // 注：PDATE 可能是昨日（今日未公布，如 QDII），收益对应 PDATE 当日，由 UI 标注
    netValue = navValid ? nav : null
    if (navValid && navChgRtValid) {
      prevNetValue = round4(nav / (1 + navChgRt / 100))
    }
    dayGrowth = navChgRtValid ? navChgRt : null
  } else {
    // 无 GSZ 也无 NAVCHGRT：仅记录净值
    netValue = navValid ? nav : null
  }

  return {
    name: String(item?.SHORTNAME || ''),
    confirmed,
    dayGrowth,
    estimateGrowth,
    netValue,
    estimateNetValue,
    prevNetValue,
    netValueDate: pdate && pdate !== '--' ? normalizeNetValueDate(pdate) : '',
    time: gztime && gztime.length >= 16 ? gztime.slice(11, 16) : null,
  }
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

    return {
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
    }
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
  const code = String(payload.code || '').trim()
  let meta: any = {}
  try {
    meta = await searchFund(code)
  } catch (e: any) {
    if (!payload.name) throw e
  }

  let sectors = Array.isArray(payload.sectors) ? payload.sectors : null
  if (!sectors?.length) {
    try {
      sectors = await fetchFundSectorsQueued(meta.code || code, payload.name || meta.name)
    } catch {
      sectors = []
    }
  }

  let netValue: number | null = null
  let prevNetValue: number | null = null
  let prevNetValueDate = ''
  let netValueDate = ''
  if ((payload.type || 'watch') === 'hold') {
    try {
      const hist = await fetchFundNavHistory(meta.code || code, 5)
      if (hist.length) {
        netValue = hist[0].netValue
        netValueDate = hist[0].date || ''
        if (hist[1]?.netValue != null) prevNetValue = hist[1].netValue
        if (hist[1]?.date) prevNetValueDate = hist[1].date
      }
    } catch {
      // ignore
    }
  }

  return {
    code: meta.code || code,
    name: payload.name || meta.name || code,
    fundKey: meta.fundKey || '',
    sectors: sectors || [],
    netValue: netValue ?? null,
    prevNetValue: prevNetValue ?? null,
    prevNetValueDate,
    netValueDate,
    confirmedSession: isConfirmedSessionActive(netValueDate),
  }
}
