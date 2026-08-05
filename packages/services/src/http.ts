const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

export type HttpResponse = {
  data: any
  headers: Headers
  status: number
}

/**
 * 调试期：所有 fallback / 重试 / 熔断全部禁用，httpGet/httpPost 失败即抛错并打印完整日志。
 * 调通后再恢复多源 fallback。
 */
async function readBodyPreview(res: Response, max = 500): Promise<string> {
  try {
    const text = await res.text()
    return text.length > max ? text.slice(0, max) + `...(共${text.length}字符)` : text
  } catch {
    return '<不可读>'
  }
}

function describeErr(e: any): string {
  if (e?.name === 'AbortError') return 'Timeout(AbortError)'
  if (e?.name === 'TypeError') return `NetworkError(${e.message})` // 通常是 Failed to fetch
  return e?.message || String(e)
}

export async function httpGet(
  url: string,
  options?: {
    headers?: Record<string, string>
    params?: Record<string, string | number | undefined>
    timeout?: number
    responseType?: 'json' | 'text' | 'arraybuffer'
    /** 是否携带 cookie；默认 omit，避免把用户在行情站点（东财/新浪等）的登录态发给第三方接口 */
    credentials?: RequestCredentials
  },
): Promise<any> {
  const {headers, params, timeout = 15000, responseType = 'json', credentials = 'omit'} =
    options || {}
  const u = new URL(url)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) u.searchParams.set(k, String(v))
    }
  }
  const fullUrl = u.toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const t0 = Date.now()
  try {
    const res = await fetch(fullUrl, {
      headers: {['User-Agent']: UA, ...headers},
      signal: controller.signal,
      credentials,
    })
    if (!res.ok) {
      const body = await readBodyPreview(res)
      const err = new Error(`HTTP ${res.status} ${res.statusText} ${u.pathname}`)
      console.warn('[fund01] httpGet 失败', {
        url: fullUrl,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - t0,
        bodyPreview: body,
      })
      throw err
    }
    if (responseType === 'arraybuffer') return await res.arrayBuffer()
    if (responseType === 'text') return await res.text()
    return await res.json()
  } catch (e: any) {
    // 网络层失败（DNS/CORS/断网/超时），非 HTTP !ok 的：补打一次
    if (!(e instanceof Error && e.message.startsWith('HTTP '))) {
      console.warn('[fund01] httpGet 网络层失败', {
        url: fullUrl,
        errorType: describeErr(e),
        durationMs: Date.now() - t0,
        errName: e?.name,
        errMsg: e?.message,
      })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function httpPost(
  url: string,
  body: any,
  options?: {
    headers?: Record<string, string>
    timeout?: number
    /** 是否携带 cookie；默认 omit，fund123 的 CSRF 会话依赖时显式传 include */
    credentials?: RequestCredentials
  },
): Promise<any> {
  const {headers, timeout = 15000, credentials = 'omit'} = options || {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ['User-Agent']: UA,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials,
    })
    if (!res.ok) {
      const bodyPreview = await readBodyPreview(res)
      console.warn('[fund01] httpPost 失败', {
        url,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - t0,
        bodyPreview,
      })
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    return await res.json()
  } catch (e: any) {
    if (!(e instanceof Error && e.message.startsWith('HTTP '))) {
      console.warn('[fund01] httpPost 网络层失败', {
        url,
        errorType: describeErr(e),
        durationMs: Date.now() - t0,
        errName: e?.name,
        errMsg: e?.message,
      })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}
