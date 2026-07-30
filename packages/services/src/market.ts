import {httpGet} from './http'

const INDEX_LIST = [
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
    }
  }
  throw lastErr || new Error('eastmoney request failed')
}

export async function getIndices() {
  const secids = INDEX_LIST.map((i) => i.secid).join(',')
  const data = await eastmoneyGet(
    '/api/qt/ulist.np/get',
    {
      fltt: 2,
      invt: 2,
      fields: 'f2,f3,f4,f12,f14',
      secids,
    },
    PUSH_HOSTS,
  )
  const diff = data?.data?.diff || []
  const byCode = new Map<string, any>(diff.map((d: any) => [String(d.f12), d]))
  return INDEX_LIST.map((item) => {
    const row = byCode.get(item.code) || byCode.get(item.secid.split('.')[1])
    const percent = row?.f3
    const change = row?.f4
    return {
      code: item.code,
      name: item.name,
      percent: typeof percent === 'number' ? percent : null,
      price: typeof row?.f2 === 'number' ? row.f2 : null,
      change: typeof change === 'number' ? change : null,
    }
  })
}

export async function getSectorBoards({sort = 'desc', size = 10} = {}) {
  const data = await eastmoneyGet(
    '/api/qt/clist/get',
    {
      pn: 1,
      pz: 80,
      po: sort === 'asc' ? 0 : 1,
      np: 1,
      fltt: 2,
      invt: 2,
      fid: 'f3',
      fs: 'm:90+t:2',
      fields: 'f12,f14,f2,f3',
    },
    PUSH_HOSTS,
  )
  const list = (data?.data?.diff || [])
    .map((d: any) => ({
      code: d.f12,
      name: d.f14,
      percent: typeof d.f3 === 'number' ? d.f3 : null,
    }))
    .filter((d: any) => d.percent != null)
    .sort((a: any, b: any) => (sort === 'asc' ? a.percent - b.percent : b.percent - a.percent))
    .slice(0, size)
  return list
}

export async function getUpDownStats() {
  const data = await httpGet('https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData', {
    params: {type: 0},
    headers: {Referer: 'https://emdatah5.eastmoney.com/'},
    timeout: 12000,
  })
  const row = Array.isArray(data) ? data[0] : data?.[0]
  if (!row) return {up: 0, down: 0, flat: 0, time: null}
  return {
    up: Number(row.up) || 0,
    down: Number(row.down) || 0,
    flat: Number(row.t) || 0,
    time: row.time || null,
  }
}

export async function getMarketOverview() {
  const [upDown, topGainers, topLosers] = await Promise.all([
    getUpDownStats(),
    getSectorBoards({sort: 'desc', size: 10}),
    getSectorBoards({sort: 'asc', size: 10}),
  ])
  return {upDown, topGainers, topLosers}
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
    } catch {
      points = []
    }
  }

  if (points.length < 10 && (meta as any).sina) {
    points = await fetchSinaCnDaily((meta as any).sina, limit)
    source = 'sina'
  }
  if ((points.length < 10 || key === '3y') && (meta as any).sinaUs) {
    try {
      const usPoints = await fetchSinaUsDaily((meta as any).sinaUs, limit)
      if (usPoints.length > points.length) {
        points = usPoints
        source = 'sina-us'
      }
    } catch {
      // keep previous
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
