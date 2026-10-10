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
  /** 实时走东财 K 线近似（如国内金 AU9999：push2 实时 ulist 已挂，改用与历史同源的东财 K 线兜底链） */
  emRealtime?: boolean
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
  // 黄金看板：
  //   国内金（上金所 AU9999 现货，元/克）：当前环境东财三 host 在 MV3 SW 跨域下全 NET、腾讯无国内金、新浪+jijinhao 强制 Referer
  //   （SW 无法设）→ 实时大概率拿不到（卡片显示「接口错误 NET」）。保留 emRealtime 走东财 K 线兜底链，一旦东财恢复即自动出数；
  //   历史 K 线（emKline）同样走东财日K 兜底。
  //   国际金（COMEX 黄金主力，美元/盎司）：实时走腾讯 hf_GC（无需 Referer，SW 可用；东财 COMEX 实时走 push2 已挂）；
  //   历史仍走新浪外盘日K（伦敦金口径，趋势一致）。
  {secid: '118.AU9999', code: 'AU9999', name: '黄金9999', emRealtime: true, emKline: true},
  {secid: '101.GC00Y', code: 'XAU', name: 'COMEX 黄金', tx: 'hf_GC', sinaFx: 'XAU'},
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

/** 东财行情 host 兜底链（push2delay 延迟行情最稳，放第一；push2 主域名对无 cookie 请求常风控秒断）。
 *   getIndices 与 fetchStockPctChanges 共用，保证行情类请求有三级 host 保险。 */
export const PUSH_HOSTS = [
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
  // 浏览器网络失败文案是 "Failed to fetch"，httpGet 的 describeErr 还会包成 "NetworkError(...)"，都归 NET
  if (msg.includes('NetworkError') || msg.includes('fetch failed') || msg.includes('Failed to fetch'))
    return 'NET'
  return 'PARSE'
}

/** 解析单条腾讯实时返回体（GBK 编码不影响 ASCII 数字；中文名用本地 INDEX_LIST，不依赖接口返回）。
 *  格式：v_xxx="市场~名称~代码~现价~昨收~今开~...~涨跌[31]~涨跌幅[32]~"，索引字段与 real-time-fund 长期验证一致。 */
function parseTencentRtRow(raw: string): {price: number; change: number; percent: number} | null {
  const parts = raw.split('~')
  if (parts.length < 33) return null
  const price = parseFloat(parts[3])
  const change = parseFloat(parts[31])
  const percent = parseFloat(parts[32])
  if (!Number.isFinite(price)) return null
  return {
    price,
    change: Number.isFinite(change) ? change : 0,
    percent: Number.isFinite(percent) ? percent : 0,
  }
}

/** 从腾讯实时整段响应提取所有 v_<code>="..." → 原始字段串 */
function parseTencentRtPayload(body: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /v_([^=]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) map.set(m[1], m[2])
  return map
}

/** 解析腾讯黄金/外汇实时返回体（hf_ 系列）：格式 `现价,涨跌,买价,卖价,最高,最低,时间,开盘,昨收,...,日期,...`
 *  与指数格式（~ 分隔、涨跌在[31]、涨跌幅在[32]）不同，无直接涨跌幅字段，需 (现价-昨收)/昨收 自算。 */
function parseTencentGoldRow(raw: string): {price: number; change: number; percent: number} | null {
  const p = raw.split(',')
  const price = parseFloat(p[0])
  const change = parseFloat(p[1])
  const prevClose = parseFloat(p[8])
  if (!Number.isFinite(price)) return null
  const percent = Number.isFinite(prevClose) && prevClose !== 0 ? (price - prevClose) / prevClose * 100 : 0
  return {
    price,
    change: Number.isFinite(change) ? change : 0,
    percent,
  }
}

/** 腾讯实时指数（A股 + 美股，需有 tx symbol）。东财 push2 挂掉时的主源。 */
async function getIndicesFromTencent(
  list: IndexMetaDef[],
): Promise<Map<string, {price: number; change: number; percent: number}>> {
  const withTx = list.filter((i) => i.tx)
  const out = new Map<string, {price: number; change: number; percent: number}>()
  if (!withTx.length) return out
  const body = (await httpGet(`https://qt.gtimg.cn/q=${withTx.map((i) => i.tx).join(',')}`, {
    params: {_t: Date.now()},
    responseType: 'text',
    headers: {Referer: 'https://gu.qq.com/'},
    timeout: 12000,
  })) as string
  const kv = parseTencentRtPayload(body)
  for (const item of withTx) {
    const raw =
      kv.get(item.tx!) ??
      (item.tx!.startsWith('us.') ? kv.get(item.tx!.replace('us.', 'us')) : undefined)
    if (!raw) continue
    // 黄金/外汇 hf_ 系列字段格式与指数不同（现价[0]、涨跌[1]、昨收[8]，无直接涨跌幅）
    const parsed = item.tx!.startsWith('hf_') ? parseTencentGoldRow(raw) : parseTencentRtRow(raw)
    if (parsed) out.set(item.code, parsed)
  }
  return out
}

/** 东财 K 线实时近似（覆盖国内金 AU9999 等 emRealtime 项）。
 *  复用 fetchEastmoneyDaily 的 host 兜底链（push2his→push2delay→push2，与走势弹窗同一数据源可用性），
 *  避免单赌 push2his 一个 host 在 SW 跨域下偶发不可达（真机实测 push2his 单点会 Failed to fetch）。
 *  盘中当日 bar 的收盘价即实时最新价，前一根收盘作昨收算涨跌，等价实时近似。
 *  返回 {map, errors}：errors 收集单只失败的错误码（NET/HTTP/NODATA），便于卡片透传真实原因。 */
async function getEmStockRealtime(
  list: IndexMetaDef[],
): Promise<{
  map: Map<string, {price: number; change: number; percent: number}>
  errors: Map<string, IndexErrorCode>
}> {
  const out = new Map<string, {price: number; change: number; percent: number}>()
  const errors = new Map<string, IndexErrorCode>()
  for (const item of list) {
    if (!item.secid) continue
    try {
      const points = await fetchEastmoneyDaily(item.secid, 2)
      if (points.length < 1) {
        errors.set(item.code, 'NODATA')
        continue
      }
      const last = points[points.length - 1]
      const prev = points.length >= 2 ? points[points.length - 2] : null
      const price = last.close
      if (price == null || !Number.isFinite(price)) {
        errors.set(item.code, 'NODATA')
        continue
      }
      // 仅1根（无昨日 bar）时用自身近似昨收，避免除零
      const prevClose = prev != null && typeof prev.close === 'number' ? prev.close : price
      const change = price - prevClose
      const percent = prevClose !== 0 ? (change / prevClose) * 100 : 0
      out.set(item.code, {price, change: Number.isFinite(change) ? change : 0, percent})
    } catch (e) {
      errors.set(item.code, indexErrorCodeOf(e))
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[fund01] getEmStockRealtime 失败 ${item.code}`, msg)
    }
  }
  return {map: out, errors}
}

/**
 * 拉取指数实时行情（条目级容错 + 多源：腾讯实时为主、东财 push2 兜底）。
 * 单条目失败不影响其余；数值处与底部展示错误状态。
 */
export async function getIndices(scope: IndexScope = 'all') {
  const list = INDEX_LIST.filter((i) =>
    scope === 'all' ? true : scope === 'us' ? !!i.sinaUs : !i.sinaUs,
  )
  // 主源：腾讯实时（A股 + 美股）。失败不抛，降级到东财。
  const tencentMap = await getIndicesFromTencent(list).catch((e) => {
    console.warn(`[fund01] getIndices 腾讯实时失败 scope=${scope}`, e)
    return new Map<string, {price: number; change: number; percent: number}>()
  })
  // 仅对腾讯没覆盖到的 emRealtime 条目（如国内金 AU9999）回退东财 K 线实时近似；
  // 东财当前环境若全 NET，则该条目透传 NET 错误码，由卡片展示「接口错误 NET」
  const emList = list.filter((i) => !tencentMap.has(i.code) && i.emRealtime)
  const emRes =
    emList.length > 0
      ? await getEmStockRealtime(emList).catch((e) => {
          console.warn(`[fund01] getIndices 东财兜底失败 scope=${scope}`, e)
          return {
            map: new Map<string, {price: number; change: number; percent: number}>(),
            errors: new Map<string, IndexErrorCode>(),
          }
        })
      : {
          map: new Map<string, {price: number; change: number; percent: number}>(),
          errors: new Map<string, IndexErrorCode>(),
        }
  return list.map((item) => {
    const t = tencentMap.get(item.code)
    if (t)
      return {code: item.code, name: item.name, percent: t.percent, price: t.price, change: t.change}
    const em = emRes.map.get(item.code)
    if (em)
      return {code: item.code, name: item.name, percent: em.percent, price: em.price, change: em.change}
    const emErr = emRes.errors.get(item.code)
    return {
      code: item.code,
      name: item.name,
      percent: null,
      price: null,
      change: null,
      error: emErr || 'NODATA',
    }
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
