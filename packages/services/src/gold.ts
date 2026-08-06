import {httpGet} from './http'
import {isTripped, recordSuccess, recordFailure} from './circuit'

const PUSH_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
]

const TREND_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
]

function round2(n: number): number {
  return Math.round(Number(n) * 100) / 100
}
function round4(n: number): number {
  return Math.round(Number(n) * 10000) / 10000
}

function parseSinaGold(text: string) {
  const m = text.match(/hq_str_gds_AU9999="([^"]*)"/)
  if (!m || !m[1]) return null
  const parts = m[1].split(',')
  const price = parseFloat(parts[0])
  const high = parseFloat(parts[4])
  const low = parseFloat(parts[5])
  const time = parts[6] || ''
  const prevClose = parseFloat(parts[7])
  const open = parseFloat(parts[8])
  const date = parts[12] || ''
  const name = parts[13] || 'AU9999'
  const percent =
    Number.isFinite(price) && Number.isFinite(prevClose) && prevClose !== 0
      ? ((price - prevClose) / prevClose) * 100
      : null
  const change =
    Number.isFinite(price) && Number.isFinite(prevClose) ? price - prevClose : null
  return {
    code: 'AU9999',
    name: name.includes('金') ? 'AU9999 沪金99' : 'AU9999',
    price: Number.isFinite(price) ? price : null,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    open: Number.isFinite(open) ? open : null,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    change: change == null ? null : round4(change),
    percent: percent == null ? null : round4(percent),
    time: date ? `${date} ${time}` : time,
    source: 'sina' as const,
  }
}

async function fetchSinaQuote() {
  const buf = await httpGet('https://hq.sinajs.cn/list=gds_AU9999', {
    responseType: 'arraybuffer',
    headers: {Referer: 'https://finance.sina.com.cn/'},
    timeout: 10000,
  })
  const text = new TextDecoder('gbk').decode(buf as ArrayBuffer)
  const quote = parseSinaGold(text)
  if (!quote) throw new Error('解析 AU9999 行情失败')
  return quote
}

async function fetchEastmoneyQuote() {
  let lastErr: any
  const hostErrors: string[] = []
  for (const host of PUSH_HOSTS) {
    try {
      const data = await httpGet(`${host}/api/qt/stock/get`, {
        params: {
          secid: '118.AU9999',
          fltt: 2,
          fields: 'f43,f44,f45,f46,f57,f58,f60,f169,f170,f171',
        },
        headers: {Referer: 'https://quote.eastmoney.com/'},
        timeout: 10000,
      })
      const d = data?.data
      if (!d || d.f43 == null) continue
      const price = Number(d.f43)
      const prevClose = Number(d.f60)
      const change =
        Number.isFinite(price) && Number.isFinite(prevClose)
          ? price - prevClose
          : d.f169 != null
            ? Number(d.f169)
            : null
      const percent =
        Number.isFinite(price) && Number.isFinite(prevClose) && prevClose
          ? ((price - prevClose) / prevClose) * 100
          : d.f170 != null
            ? Number(d.f170)
            : null
      return {
        code: 'AU9999',
        name: d.f58 ? `AU9999 ${d.f58}` : 'AU9999 沪金99',
        price: Number.isFinite(price) ? price : null,
        prevClose: Number.isFinite(prevClose) ? prevClose : null,
        open: d.f46 != null ? Number(d.f46) : null,
        high: d.f44 != null ? Number(d.f44) : null,
        low: d.f45 != null ? Number(d.f45) : null,
        change: change == null || !Number.isFinite(change) ? null : round4(change),
        percent: percent == null || !Number.isFinite(percent) ? null : round4(percent),
        time: '',
        source: 'eastmoney' as const,
      }
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      hostErrors.push(`${host}: ${msg}`)
    }
  }
  if (hostErrors.length) {
    console.warn(`[fund01] fetchEastmoneyQuote ${hostErrors.length}/${PUSH_HOSTS.length} host 失败`, hostErrors)
  }
  throw lastErr || new Error('东财 AU9999 行情失败')
}

async function fetchQuote() {
  try {
    return await fetchEastmoneyQuote()
  } catch {
    return fetchSinaQuote()
  }
}

// 黄金走势熔断器：所有走势源（东财 push2his + jijinhao）都失败时累计，
// 连续失败 3 次后冷却 5 分钟，避免 push2his 持续宕机时每个刷新周期都刷屏。
const TREND_CIRCUIT_KEY = 'gold-trend'
const TREND_CIRCUIT_OPTS = {
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  label: 'gold-trend',
}

async function fetchTrend(prevCloseHint: number | null): Promise<any[]> {
  // 熔断期内直接返回空，不发任何请求（避免刷屏 + 无谓请求）
  if (isTripped(TREND_CIRCUIT_KEY)) return []

  let points: any[] = []
  const hostErrors: string[] = []
  for (const host of TREND_HOSTS) {
    try {
      const data = await httpGet(`${host}/api/qt/stock/trends2/get`, {
        params: {
          fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
          fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
          ndays: 1,
          iscr: 0,
          secid: '118.AU9999',
        },
        headers: {Referer: 'https://quote.eastmoney.com/'},
        timeout: 10000,
      })
      const trends = data?.data?.trends || []
      if (!trends.length) continue
      const preClose = parseFloat(data?.data?.preClosePrice) || prevCloseHint || 0
      points = trends.map((line: string) => {
        const [dt, , price] = line.split(',')
        const p = parseFloat(price)
        const time = (dt || '').split(' ')[1] || dt
        const percent =
          Number.isFinite(p) && Number.isFinite(preClose) && preClose
            ? ((p - preClose) / preClose) * 100
            : null
        return {
          time,
          price: p,
          percent: percent == null ? null : round4(percent),
        }
      })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      hostErrors.push(`${host}: ${msg}`)
    }
  }
  // 汇总打印一次，避免每个 host 都刷屏（熔断后此分支不会执行）
  if (hostErrors.length) {
    console.warn(`[fund01] fetchTrend(eastmoney) ${hostErrors.length}/${TREND_HOSTS.length} host 失败`, hostErrors)
  }

  // 东财所有 host 都失败，尝试 jijinhao 备用源
  if (!points.length) {
    try {
      const data = await httpGet('https://api.jijinhao.com/sQuoteCenter/todayMin.htm', {
        params: {code: 'JO_71', isCalc: 'true'},
        headers: {Referer: 'https://quote.cngold.org/'},
        timeout: 10000,
      })
      const json = JSON.parse(String(data).replace('var hq_str_ml = ', ''))
      const base = Number.isFinite(prevCloseHint as number) && (prevCloseHint as number) > 0 ? prevCloseHint : null
      const jijinPoints = (json.data || [])
        .filter((x: any) => x.price != null && x.price !== -1)
        .map((x: any) => {
          const price = round2(x.price)
          const ref = base ?? null
          return {
            time: x.time || new Date(x.date).toTimeString().slice(0, 5),
            price,
            percent: ref && price ? round4(((price - ref) / ref) * 100) : null,
          }
        })
      if (jijinPoints.length) {
        if (jijinPoints[0].percent == null) {
          const first = jijinPoints[0].price
          points = jijinPoints.map((p: any) => ({
            ...p,
            percent: first ? round4(((p.price - first) / first) * 100) : null,
          }))
        } else {
          points = jijinPoints
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('[fund01] fetchTrend(jijinhao) 失败', msg)
    }
  }

  // 熔断器计数：拿到数据=成功（清零），全部失败=失败（累计/熔断）
  if (points.length) {
    recordSuccess(TREND_CIRCUIT_KEY)
  } else {
    recordFailure(TREND_CIRCUIT_KEY, TREND_CIRCUIT_OPTS)
  }

  return points
}

export async function getGoldRealtime({holding = 0, avgPrice = 0} = {}) {
  const quote: any = await fetchQuote()
  const trend = await fetchTrend(quote.prevClose)

  if ((quote.percent == null || quote.change == null) && trend.length) {
    const last = trend[trend.length - 1]
    if (quote.price == null && last.price != null) quote.price = last.price
    if (quote.percent == null && last.percent != null) quote.percent = last.percent
    if (quote.change == null && quote.price != null && quote.prevClose != null) {
      quote.change = round4(quote.price - quote.prevClose)
    }
  }

  const hold = Number(holding) || 0
  const avg = Number(avgPrice) || 0

  let pnl: number | null = null
  if (hold > 0 && quote.price != null && quote.prevClose != null) {
    const delta = quote.price - quote.prevClose
    quote.change = round4(delta)
    pnl = round2(hold * delta)
  }

  let costPnl: number | null = null
  let costPnlPercent: number | null = null
  if (hold > 0 && avg > 0 && quote.price != null) {
    costPnl = round2((quote.price - avg) * hold)
    costPnlPercent = round2(((quote.price - avg) / avg) * 100)
  }

  return {
    ...quote,
    trend,
    holding: hold,
    avgPrice: avg,
    pnl,
    pnlPercent: quote.percent == null ? null : round2(quote.percent),
    costPnl,
    costPnlPercent,
  }
}
