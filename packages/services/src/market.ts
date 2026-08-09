import {httpGet} from './http'

type IndexMetaDef = {
  secid: string
  code: string
  name: string
  /** 腾讯日K symbol（gu.qq.com） */
  tx?: string
  /** 新浪 A股日K symbol */
  sina?: string
  /** 新浪美股日K symbol */
  sinaUs?: string
  /** 历史 K 线走东财 kline（如国内金 118.AU9999） */
  emKline?: boolean
  /** 新浪外盘 symbol：实时走 hq.sinajs.cn、历史走 GlobalFuturesService（如伦敦金 XAU） */
  sinaFx?: string
}

const INDEX_LIST: IndexMetaDef[] = [
  {secid: '1.000001', code: '000001', name: '上证指数', tx: 'sh000001'},
  {secid: '0.399001', code: '399001', name: '深证成指', tx: 'sz399001'},
  {secid: '0.399006', code: '399006', name: '创业板指', tx: 'sz399006'},
  {secid: '0.899050', code: '899050', name: '北证50', sina: 'bj899050'},
  {secid: '1.000688', code: '000688', name: '科创50', tx: 'sh000688'},
  {secid: '1.000016', code: '000016', name: '上证50', tx: 'sh000016'},
  {secid: '1.000300', code: '000300', name: '沪深300', tx: 'sh000300'},
  {secid: '1.000905', code: '000905', name: '中证500', tx: 'sh000905'},
  {secid: '100.NDX', code: 'NDX', name: '纳斯达克100', tx: 'us.NDX', sinaUs: '.NDX'},
  {secid: '100.SPX', code: 'SPX', name: '标普500', tx: 'us.INX', sinaUs: '.INX'},
  // 黄金看板：国内金（上金所现货，元/克）实时+历史都走东财；国际金实时走东财 COMEX 主力（GC00Y，美元/盎司，
  // 不依赖 Referer——新浪 hq.sinajs.cn 强制校验 Referer，chrome SW fetch 无法携带自定义 Referer 头会 Forbidden），
  // 历史走新浪外盘日K（GlobalFuturesService 不依赖 Referer），实时与历史同为国际金价、趋势一致
  {secid: '118.AU9999', code: 'AU9999', name: '黄金9999', emKline: true},
  {secid: '101.GC00Y', code: 'XAU', name: 'COMEX 黄金', sinaFx: 'XAU'},
]

const RANGE_CALENDAR_DAYS: Record<string, number> = {
  '1m': 35,
  '3m': 100,
  '6m': 200,
  '1y': 400,
  '3y': 1200,
}

const RANGE_FETCH_LIMIT: Record<string, number> = {
  '1m': 60,
  '3m': 120,
  '6m': 200,
  '1y': 320,
  '3y': 900,
}

const PUSH_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
]

async function eastmoneyGet(
  url: string,
  params: Record<string, any>,
  hosts: string[],
): Promise<any> {
  let lastErr: any
  for (const host of hosts) {
    try {
      return await httpGet(`${host}${url}`, {
        params,
        headers: {Referer: 'https://quote.eastmoney.com/'},
        timeout: 12000,
      })
    } catch (e) {
      lastErr = e
      // 打印 fallback 链每次失败，便于定位是哪个 host / 接口出问题
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] eastmoneyGet 失败 host=${host} path=${url}`, msg)
    }
  }
  throw lastErr || new Error('eastmoney request failed')
}

export type IndexScope = 'all' | 'ashare' | 'us'

/** 该指数 code 是否美股指数（NDX/SPX） */
export function isUsIndexCode(code: string): boolean {
  return INDEX_LIST.some((i) => i.sinaUs && i.code === code)
}

/** 指数行情错误码（简短，用于看板卡片底部展示） */
export type IndexErrorCode = 'NET' | 'TIMEOUT' | 'HTTP' | 'NODATA' | 'PARSE'

/** 把接口异常归类为简短错误码（http.ts 的 describeErr 前缀） */
function indexErrorCodeOf(e: any): IndexErrorCode {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.startsWith('HTTP ')) return 'HTTP'
  if (msg.includes('Timeout') || msg.includes('Abort')) return 'TIMEOUT'
  if (msg.includes('NetworkError') || msg.includes('fetch failed')) return 'NET'
  return 'PARSE'
}

/**
 * 拉取指数实时行情（条目级容错：单个/整体接口失败不抛错，对应条目带 error 码，
 * 保证看板卡片始终能在 popup 显示，数值处与底部展示错误状态）。
 */
export async function getIndices(scope: IndexScope = 'all') {
  const list = INDEX_LIST.filter((i) =>
    scope === 'all' ? true : scope === 'us' ? !!i.sinaUs : !i.sinaUs,
  )
  const secids = list.map((i) => i.secid).join(',')
  let data: any = null
  let fetchErr: IndexErrorCode | null = null
  try {
    data = await eastmoneyGet(
      '/api/qt/ulist.np/get',
      {
        fltt: 2,
        invt: 2,
        fields: 'f2,f3,f4,f12,f14',
        secids,
      },
      PUSH_HOSTS,
    )
  } catch (e) {
    fetchErr = indexErrorCodeOf(e)
    console.warn(`[fund01] getIndices 失败 scope=${scope}`, e)
  }
  const diff = data?.data?.diff || []
  const byCode = new Map<string, any>(diff.map((d: any) => [String(d.f12), d]))
  return list.map((item) => {
    // 接口整体失败 → 全部条目报接口错误码；成功但条目缺失 → NODATA
    if (fetchErr) {
      return {
        code: item.code,
        name: item.name,
        percent: null,
        price: null,
        change: null,
        error: fetchErr,
      }
    }
    // COMEX 黄金（XAU）以 GC00Y 代理，secid 匹配到行后沿用 INDEX_LIST 名称
    const row = byCode.get(item.code) || byCode.get(item.secid.split('.')[1])
    if (!row) {
      return {
        code: item.code,
        name: item.name,
        percent: null,
        price: null,
        change: null,
        error: 'NODATA' as IndexErrorCode,
      }
    }
    const percent = typeof row?.f3 === 'number' ? row.f3 : null
    const change = typeof row?.f4 === 'number' ? row.f4 : null
    const price = typeof row?.f2 === 'number' ? row.f2 : null
    return {code: item.code, name: item.name, percent, price, change}
  })
}

function findIndexMeta(code: string) {
  const key = String(code || '').trim()
  return INDEX_LIST.find((i) => i.code === key || i.secid.endsWith(`.${key}`))
}

function round4(n: number): number {
  return Math.round(Number(n) * 10000) / 10000
}

function filterByRange(points: {date: string; close: number | null}[], range: string) {
  const days = RANGE_CALENDAR_DAYS[range] || RANGE_CALENDAR_DAYS['1m']
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days)
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
  return points.filter((p) => p.date >= startStr)
}

function withPeriodPercent(points: {date: string; close: number | null}[]) {
  if (!points.length) return []
  const base = points[0].close
  if (!base) return points.map((p) => ({...p, percent: null}))
  return points.map((p) => ({
    ...p,
    percent: round4(((p.close! - base) / base) * 100),
  }))
}

async function fetchTencentDaily(symbol: string, limit: number) {
  const data = await httpGet('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', {
    params: {param: `${symbol},day,,,${limit},qfq`},
    headers: {Referer: 'https://gu.qq.com/'},
    timeout: 15000,
  })
  const key = Object.keys(data?.data || {})[0]
  const rows = data?.data?.[key]?.qfqday || data?.data?.[key]?.day || []
  return rows
    .map((row: any[]) => {
      const close = parseFloat(row[2])
      return {date: row[0], close: Number.isFinite(close) ? close : null}
    })
    .filter((p: any) => p.date && p.close != null)
}

async function fetchSinaCnDaily(symbol: string, limit: number) {
  const data = await httpGet(
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData',
    {
      params: {symbol, scale: 240, ma: 'no', datalen: limit},
      headers: {Referer: 'https://finance.sina.com.cn/'},
      timeout: 15000,
    },
  )
  const rows = Array.isArray(data) ? data : []
  return rows
    .map((row: any) => {
      const close = parseFloat(row.close)
      return {date: row.day, close: Number.isFinite(close) ? close : null}
    })
    .filter((p: any) => p.date && p.close != null)
}

async function fetchSinaUsDaily(symbol: string, limit: number) {
  const data = await httpGet(
    'https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinKService.getDailyK',
    {
      params: {symbol},
      headers: {Referer: 'https://stock.finance.sina.com.cn/'},
      timeout: 20000,
    },
  )
  const rows = Array.isArray(data) ? data : []
  const mapped = rows
    .map((row: any) => {
      const close = parseFloat(row.c)
      return {date: row.d, close: Number.isFinite(close) ? close : null}
    })
    .filter((p: any) => p.date && p.close != null)
  return mapped.slice(-limit)
}

/** 东财日K（klt=101，fqt=1 不复权）：国内金 118.AU9999 用 */
async function fetchEastmoneyDaily(secid: string, limit: number) {
  const hosts = [
    'https://push2his.eastmoney.com',
    'https://push2delay.eastmoney.com',
    'https://push2.eastmoney.com',
  ]
  let lastErr: any
  for (const host of hosts) {
    try {
      const data = await httpGet(`${host}/api/qt/stock/kline/get`, {
        params: {
          secid,
          klt: 101,
          fqt: 1,
          end: '20500101',
          lmt: limit,
          fields1: 'f1,f2,f3,f4,f5,f6',
          fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
        },
        headers: {Referer: 'https://quote.eastmoney.com/'},
        timeout: 12000,
      })
      const klines: string[] = data?.data?.klines || []
      const points = klines
        .map((line: string) => {
          const [date, , close] = line.split(',')
          const c = parseFloat(close)
          return {date, close: Number.isFinite(c) ? c : null}
        })
        .filter((p: any) => p.date && p.close != null)
      if (points.length) return points
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchEastmoneyDaily 失败 host=${host}`, msg)
    }
  }
  throw lastErr || new Error(`东财 ${secid} K线失败`)
}

/** 新浪外盘日K（GlobalFuturesService，JSONP）：伦敦金 XAU 用，返回升序取末 limit 条 */
async function fetchSinaFxDaily(symbol: string, limit: number) {
  const text = await httpGet(
    'https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20gc=/GlobalFuturesService.getGlobalFuturesDailyKLine',
    {
      params: {symbol},
      responseType: 'text',
      headers: {Referer: 'https://finance.sina.com.cn/'},
      timeout: 15000,
    },
  )
  const start = (text as string).indexOf('[')
  const end = (text as string).lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let rows: any[] = []
  try {
    rows = JSON.parse((text as string).slice(start, end + 1))
  } catch {
    return []
  }
  const points = rows
    .map((row: any) => {
      const close = parseFloat(row.close)
      return {date: row.date, close: Number.isFinite(close) ? close : null}
    })
    .filter((p: any) => p.date && p.close != null)
  return points.slice(-limit)
}

export async function getIndexHistory(code: string, range = '1m') {
  const meta = findIndexMeta(code)
  if (!meta) throw new Error(`未知指数 ${code}`)
  const key = RANGE_CALENDAR_DAYS[range] ? range : '1m'
  const limit = RANGE_FETCH_LIMIT[key]

  let points: {date: string; close: number | null}[] = []
  let source = ''

  if (meta.tx) {
    try {
      points = await fetchTencentDaily(meta.tx, limit)
      source = 'tencent'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchTencentDaily 失败 tx=${meta.tx}`, msg)
      points = []
    }
  }

  if (points.length < 10 && (meta as any).sina) {
    try {
      points = await fetchSinaCnDaily((meta as any).sina, limit)
      source = 'sina'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchSinaCnDaily 失败 sina=${(meta as any).sina}`, msg)
    }
  }
  if ((points.length < 10 || key === '3y') && meta.sinaUs) {
    try {
      const usPoints = await fetchSinaUsDaily(meta.sinaUs, limit)
      if (usPoints.length > points.length) {
        points = usPoints
        source = 'sina-us'
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchSinaUsDaily 失败 sinaUs=${meta.sinaUs}`, msg)
    }
  }

  // 黄金看板：国内金（AU9999）走东财日K，国际金（伦敦金）走新浪外盘日K
  if (points.length < 10 && meta.emKline) {
    try {
      points = await fetchEastmoneyDaily(meta.secid, limit)
      source = 'eastmoney'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchEastmoneyDaily 失败 secid=${meta.secid}`, msg)
    }
  }
  if (points.length < 10 && meta.sinaFx) {
    try {
      const fxPoints = await fetchSinaFxDaily(meta.sinaFx, limit)
      if (fxPoints.length > points.length) {
        points = fxPoints
        source = 'sina-fx'
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] fetchSinaFxDaily 失败 symbol=${meta.sinaFx}`, msg)
    }
  }

  if (!points.length) throw new Error(`暂无 ${meta.name} 历史行情`)

  const filtered = withPeriodPercent(filterByRange(points, key))
  const first = filtered[0]
  const last = filtered[filtered.length - 1]
  const periodPercent =
    first && last && first.close ? round4(((last.close! - first.close!) / first.close!) * 100) : null

  return {
    code: meta.code,
    name: meta.name,
    range: key,
    source,
    periodPercent,
    points: filtered,
  }
}
