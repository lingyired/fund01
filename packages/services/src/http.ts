const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

export type HttpResponse = {
  data: any
  headers: Headers
  status: number
}

export async function httpGet(
  url: string,
  options?: {
    headers?: Record<string, string>
    params?: Record<string, string | number | undefined>
    timeout?: number
    responseType?: 'json' | 'text' | 'arraybuffer'
  },
): Promise<any> {
  const {headers, params, timeout = 15000, responseType = 'json'} = options || {}
  const u = new URL(url)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) u.searchParams.set(k, String(v))
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(u.toString(), {
      headers: {['User-Agent']: UA, ...headers},
      signal: controller.signal,
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${u.pathname}`)
    if (responseType === 'arraybuffer') return await res.arrayBuffer()
    if (responseType === 'text') return await res.text()
    return await res.json()
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
  },
): Promise<any> {
  const {headers, timeout = 15000} = options || {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
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
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}
