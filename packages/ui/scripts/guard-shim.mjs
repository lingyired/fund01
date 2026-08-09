// guard-shim.mjs
// 构建/CI 守卫：扫描 packages/ui/src 源码里实际用到的原子类，
// 逐个比对 tw-shim.css（及同目录其它 *.css）白名单。
// 凡是「源码用到、白名单却没有对应 CSS 规则」的类，一律报错退出（exit 1），
// 把 tw-shim 的「静默失败」变成「响亮失败」。
//
// 用法（在 packages/ui 下）：node scripts/guard-shim.mjs
// 退出码：0 = 全部命中；1 = 发现缺失类（应阻断 CI / 构建）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 仓库根（packages/ui 的上一级）
const UI_SRC = resolve(__dirname, '..', 'src')
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx'])

// ---- 1. 解析白名单：从 css 文件提取所有 .class 选择器（去转义） ----
function unescapeCss(sel) {
  return sel.replace(/\\(.)/g, '$1')
}

// 去掉末尾的伪类/伪元素，便于「hover:x:hover」也能匹配到「hover:x」
const PSEUDO_RE =
  /(?::(?:hover|active|focus|focus-visible|focus-within|disabled|visited|checked|first|last|odd|even|empty|read-only|before|after)|::[a-z-]+)$/

function selectorsFromCss(cssText) {
  const set = new Set()
  // 先整体去转义（`.bg-paper-deep\/40` → `.bg-paper-deep/40`），
  // 否则反斜杠会截断 token 匹配，把合法类误判为缺失。
  const text = unescapeCss(cssText)
  // 一条规则的选择器可能是复合选择器（如 `space-y-2 > :not([hidden]) ~ ...`），
  // 这里逐个提取其中所有 `.token`（含变体/任意值/透明度写法）。
  const re = /\.([A-Za-z0-9_:\/\[\]()#%.,-]+)/g
  let m
  while ((m = re.exec(text))) {
    const raw = m[1].trim()
    if (!raw) continue
    set.add(raw)
    const base = raw.replace(PSEUDO_RE, '')
    if (base !== raw) set.add(base)
  }
  return set
}

function collectDefinedClasses() {
  const defined = new Set()
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
      } else if (name.endsWith('.css')) {
        const txt = readFileSync(full, 'utf8')
        for (const s of selectorsFromCss(txt)) defined.add(s)
      }
    }
  }
  walk(UI_SRC)
  return defined
}

// ---- 2. 扫描源码里的类名字符串 ----
// 2a. className="..."  /  className='...'
// 2b. className={`...`}  —— 去掉 ${...} 插值
// 2c. cn(...)  —— 找到匹配右括号，提取其中所有 '...' / "..." 字面量
function stripTpl(t) {
  return t.replace(/\$\{[^}]*\}/g, ' ')
}

function matchParen(code, openIdx) {
  // openIdx 指向 '('
  let depth = 0
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function extractClassStrings(code) {
  const out = []
  const reStatic = /className\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/g
  let m
  while ((m = reStatic.exec(code))) out.push(m[2])
  const reTpl = /className\s*=\s*`([\s\S]*?)`/g
  while ((m = reTpl.exec(code))) out.push(stripTpl(m[1]))
  const reCn = /(?<![.\w])cn\s*\(/g
  while ((m = reCn.exec(code))) {
    const openIdx = m.index + m[0].length - 1 // '('
    const closeIdx = matchParen(code, openIdx)
    if (closeIdx === -1) continue
    const body = code.slice(openIdx + 1, closeIdx)
    // 去掉比较操作数里的字符串字面量（如 `align === 'right'`），避免把比较值当类名
    const cleaned = body.replace(/(!==|===|==|!=)\s*(["'])[^"']*\2/g, '$1')
    const reStr = /(["'])((?:\\.|(?!\1).)*)\1/g
    let s
    while ((s = reStr.exec(cleaned))) out.push(s[2])
  }
  return out
}

function collectUsedTokens() {
  const used = new Set()
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (SRC_EXTS.has(name.slice(name.lastIndexOf('.')))) {
        const code = readFileSync(full, 'utf8')
        for (const lit of extractClassStrings(code)) {
          for (const tok of lit.split(/\s+/)) {
            const t = tok.trim()
            if (t) used.add(t)
          }
        }
      }
    }
  }
  walk(UI_SRC)
  return used
}

// ---- 3. 比对 ----
function main() {
  const defined = collectDefinedClasses()
  const used = collectUsedTokens()

  // 忽略规则：明显非白名单、由外部库定义的类
  const IGNORE_PREFIX = ['rt-'] // Radix Themes 组件类（定义在 node_modules）
  const ignored = (t) => IGNORE_PREFIX.some((p) => t.startsWith(p))

  const missing = []
  for (const t of [...used].sort()) {
    if (ignored(t)) continue
    if (defined.has(t)) continue
    // 容忍：含模板插值残留（理论上已被 strip，保险起见）
    if (t.includes('${') || t.includes('{')) continue
    missing.push(t)
  }

  if (missing.length === 0) {
    console.log(
      `✓ guard-shim: 所有源码用到的原子类都在 tw-shim 白名单中（已扫描 ${used.size} 个去重类）。`,
    )
    process.exit(0)
  }

  console.error('✗ guard-shim: 发现源码用到但白名单缺失的原子类（静默失败隐患）：')
  for (const t of missing) console.error(`   - ${t}`)
  console.error(
    `\n共 ${missing.length} 个。请在 packages/ui/src/tw-shim.css 补上对应规则，或确认该类由外部样式定义。`,
  )
  process.exit(1)
}

main()
