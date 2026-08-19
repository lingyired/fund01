#!/usr/bin/env node
// macOS 10.15–12 兼容层产物生成器（tauri 前端构建产物后处理）
//
// 背景：主 CSS（@radix-ui/themes 3.x + tw-shim）依赖 Safari 16.2+（@layer / color-mix /
// :where 等），macOS 11 (Safari 14.1) / 10.15 (Safari 13.1) 的 WKWebView 遇到 @layer
// at-rule 会整块跳过 → 样式全丢 → 白屏（见 docs/macOS11白屏-兼容性诊断.md）。
// 另：node_modules 依赖（如 @radix-ui/react-collection）dist 自带 ES2022 语法（class
// 私有字段 / static block，Safari 13.1 无法解析、整包 SyntaxError）——Rsbuild 的 swc
// 规则默认排除 node_modules，只能构建后整包转译。
//
// 本脚本产出：
//  1. index-<hash>.compat.css（@layer 展开、color-mix 降级为实色、:where/:is 展开、
//     :focus-visible→:focus、dvh→vh），并改写 dist/index.html / options.html 注入运行时
//     特性检测：CSS.supports('background','color-mix(in srgb, red, blue)') 为 false 时
//     禁用主 CSS link（media='not all'）并加载 compat.css。
//  2. 用 esbuild 把 dist/index.js / options.js 整包转译到 es2020（回写原文件，
//     去掉 ES2022+ 语法；新旧系统行为一致，minify 保持体积）。
// macOS 13+（Safari 16.2+）CSS 走完整样式，零影响；JS 为全平台安全转译。
//
// 兼容产物允许视觉降级（用户已确认）：color-mix 半透明 → 实色、:has/:hover 样式丢弃、
// 10.15 上 flex gap 失效等，目标是「能跑起来」。
//
// 用法：node scripts/build-compat.mjs [distDir]   （默认 apps/tauri/dist）
// 依赖（根 devDependencies）：postcss、@csstools/postcss-cascade-layers、
// postcss-selector-parser、esbuild
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import postcssCascadeLayers from '@csstools/postcss-cascade-layers'
import selectorParser from 'postcss-selector-parser'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'apps/tauri/dist')
const cssDir = path.join(distDir, 'static/css')

if (!existsSync(cssDir)) {
  console.error(`[compat-css] 未找到 ${cssDir}，请先执行前端构建`)
  process.exit(1)
}

// 规范层序（与 packages/ui/src/index.css:11 一致；minifier 会把声明顺序打乱，
// prepend 一句声明即可让「后声明的层优先级更高」按源码意图生效）
const KNOWN_LAYERS = ['theme', 'base', 'radix-themes', 'components', 'utilities']

// ─────────────────────────── :where/:is 展开（递归笛卡尔） ───────────────────────────
// Safari 13.1 不认识 :where()/:is() → 整条规则被解析器丢弃。
// 展开 = 把伪类内部选择器列表拼回原位（:where(.a,.b) > .c → .a > .c, .b > .c）。
// 必须 AST 级处理（正则不可行：有嵌套/中缀形态），且先于 @layer 展开执行。
const TARGET_PSEUDOS = new Set([':where', ':is'])

function expandSelector(sel, depth = 0) {
  if (depth > 10) return [sel.clone()] // 防爆
  // 文档序第一个 :where/:is（含嵌套在 :has()/其他伪类内的）
  let target = null
  sel.walkPseudos((p) => {
    if (!target && TARGET_PSEUDOS.has(p.value.toLowerCase())) target = p
  })
  if (!target) return [sel.clone()]
  const inners = target.nodes
  if (!inners || inners.length === 0) return [] // :where() 空参数 → 丢弃该规则
  const results = []
  for (const inner of inners) {
    const innerNodes = inner.nodes
    // 内层以 combinator 结尾（如 ".a >"）无法拼接 → 丢弃该规则
    if (innerNodes.length && innerNodes[innerNodes.length - 1].type === 'combinator') return []
    if (innerNodes.length === 0) continue // 空分支（如 ", .b" 中的前导空）跳过
    const clone = sel.clone()
    let t = null
    clone.walkPseudos((p) => {
      if (!t && TARGET_PSEUDOS.has(p.value.toLowerCase())) t = p
    })
    if (!t) continue
    const parent = t.parent
    const idx = parent.index(t)
    t.remove()
    const innerClones = innerNodes.map((n) => n.clone())
    // t 若在中间，其后的 combinator/复合选择器自然拼接；用锚点节点插入保持顺序
    const anchor = idx < parent.nodes.length ? parent.nodes[idx] : null
    for (const n of innerClones) {
      if (anchor) parent.insertBefore(anchor, n)
      else parent.append(n)
    }
    results.push(clone)
  }
  const out = []
  for (const r of results) out.push(...expandSelector(r, depth + 1))
  return out
}

const unwrapWhereIs = () => ({
  postcssPlugin: 'compat-unwrap-where-is',
  OnceExit(root) {
    root.walkRules((rule) => {
      if (!rule.selector.includes(':where(') && !rule.selector.includes(':is(')) return
      const ast = selectorParser().astSync(rule.selector)
      const expanded = []
      for (const sel of ast.nodes) expanded.push(...expandSelector(sel))
      if (expanded.length === 0) {
        rule.remove()
        return
      }
      if (expanded.length > 64) {
        // 笛卡尔爆炸保护：丢弃规则（可接受降级）
        rule.remove()
        return
      }
      rule.selector = expanded.map((s) => s.toString()).join(', ')
    })
  },
})
unwrapWhereIs.postcss = true

// :focus-visible（Safari 15.4+）→ :focus
const focusVisibleFix = () => ({
  postcssPlugin: 'compat-focus-visible-fix',
  Rule(rule) {
    if (rule.selector.includes(':focus-visible')) {
      rule.selector = rule.selector.replace(/:focus-visible/g, ':focus')
    }
  },
})
focusVisibleFix.postcss = true

// ─────────────────────────── color-mix 静态降级（解析色板 → rgba，双主题） ───────────────────────────
// Safari 16.2+ 才支持 color-mix；旧版不认识 → 该条声明被解析器丢弃（元素透明/无色）。
// 构建期把 var(--xxx) 链解析成具体颜色并计算混合结果：
//   · 与 transparent 混合（bg-panel/60 等 alpha 工具类、--tw-gradient-from/to）→
//     rgba(色, pct/100)，恢复半透明层级感（旧版降级观感最大提升点）；
//   · 两色混合 → sRGB 分量插值（近似，旧系统降级可接受）。
// 生成两条规则跟随主题：默认规则用 light 值，`.dark,.dark-theme` 前缀规则用 dark 值
// （项目 applyTheme 在 <html> 上 toggle .dark/.light，见 packages/ui/src/theme.ts；
//   dark 色板取自 Radix 的 .dark/.dark-theme 与 .radix-themes:not(.light,...) 定义）。
// 解析失败（token 是 oklch/display-p3/运行时才定）→ 回退旧策略（取非 transparent 实色 var 引用）。
const colorMixFallback = () => {
  const baseTokens = new Map() // 非主题特化的基础定义（:root / :where(.radix-themes) / .radix-themes）
  const lightTokens = new Map() // light 特化（html[data-theme=light] / .light / .light-theme）
  const darkTokens = new Map() // dark 特化（.dark / .dark-theme / .radix-themes:not(.light,...)）
  const pendingRules = [] // { rule, props: Map<prop, { light, dark }> }

  // 收集顶层规则（跳过 @media/@supports 等条件 at-rule；@layer/@keyframes 内有效——
  // 主 CSS 的 Radix token 定义都在 @layer radix-themes 里）的 --* 自定义属性。
  // light 解析用 [light, base]；dark 解析用 [dark, base]（跳过 light 特化，
  // 否则 html[data-theme=light] 的值会污染 dark 场景）。
  const collectTokens = (root) => {
    const hasConditionalAncestor = (node) => {
      let p = node.parent
      while (p) {
        if (p.type === 'atrule' && !['layer', 'keyframes'].includes(p.name)) return true
        p = p.parent
      }
      return false
    }
    root.walkRules((rule) => {
      if (hasConditionalAncestor(rule)) return
      const sel = rule.selector || ''
      let table = baseTokens
      if (/\.dark(?:-theme)?|:not\(\.light/.test(sel)) table = darkTokens
      else if (/html\[data-theme=light\]|\.light(?:-theme)?/.test(sel)) table = lightTokens
      rule.walkDecls((d) => {
        if (d.prop.startsWith('--')) table.set(d.prop, d.value.trim())
      })
    })
  }

  // token 定义规则（:root / :where / .dark / .radix-themes / html...）：里面的 color-mix
  // 是"定义值"，交给主题机制自行解析 → 只做简单降级（实色 var），不做 rgba 双主题。
  const isTokenRule = (sel) =>
    /^:root|^:where|^\.dark|^\.dark-theme|^\.radix-themes|^html/.test(sel)

  // 解析颜色值（含 var 链），tables = [主表, 回退表...]（dark 解析 = [dark, base]）
  const parseColorChain = (raw, tables, depth = 0) => {
    if (depth > 10 || !raw) return null
    let s = raw.trim()
    // var(--x, fallback)
    const vm = s.match(/^var\((--[\w-]+)(?:,\s*([^)]*))?\)$/)
    if (vm) {
      const key = vm[1]
      for (const t of tables) {
        if (t.has(key)) return parseColorChain(t.get(key), tables, depth + 1)
      }
      if (vm[2]) return parseColorChain(vm[2], tables, depth + 1)
      return null
    }
    // hex
    const hx = s.match(/^#([0-9a-f]{3,8})$/i)
    if (hx) return parseHex(hx[1])
    // rgb()/rgba()
    const rgb = s.match(/^rgba?\((.*)\)$/i)
    if (rgb) return parseRgbArgs(rgb[1])
    // 命名色（常用集 + transparent）
    const named = NAMED_COLORS[s.toLowerCase()]
    if (named) return named
    return null
  }

  // 求值单个 color-mix 调用 → {r,g,b,a} | null（用给定表链）
  const mixToRgba = (inner, tables) => {
    const parts = splitTopLevel(inner)
    const colors = parts.slice(1)
    if (colors.length < 2) return null
    const a = parseColorArg(colors[0], tables)
    const b = parseColorArg(colors[1], tables)
    if (!a || !b) return null
    // 与 transparent 混合 → 带 alpha 版本（alpha = 非 transparent 方的占比）
    if (a.color === null) return { r: b.r, g: b.g, bl: b.bl, a: b.a * b.pct }
    if (b.color === null) return { r: a.r, g: a.g, bl: a.bl, a: a.a * a.pct }
    // 两色混合 → sRGB 分量插值
    const ta = a.pct, tb = b.pct
    const sum = ta + tb
    const wa = ta / sum, wb = tb / sum
    return {
      r: Math.round(a.r * wa + b.r * wb),
      g: Math.round(a.g * wa + b.g * wb),
      bl: Math.round(a.bl * wa + b.bl * wb),
      a: a.a * wa + b.a * wb,
    }
  }

  const parseColorArg = (raw, tables) => {
    const pctM = raw.match(/\s+(\d+(?:\.\d+)?)%$/)
    const pct = pctM ? parseFloat(pctM[1]) / 100 : 0.5 // 缺省 50%
    const colorStr = raw.replace(/\s+\d+(?:\.\d+)?%$/, '').trim()
    if (colorStr === 'transparent') return { color: null, pct }
    const c = parseColorChain(colorStr, tables)
    return c ? { color: c, pct, ...c } : null
  }

  // 简单降级（token 定义规则用）：取非 transparent 实色 var 引用
  const simpleFallback = (decl, calls) => {
    let value = decl.value
    for (const c of [...calls].reverse()) {
      const fb = colorMixFallbackValue(c.inner)
      if (fb === null) return false
      value = value.slice(0, c.start) + fb + value.slice(c.end)
    }
    if (value.includes('color-mix(')) return false
    decl.value = value
    return true
  }

  return {
    postcssPlugin: 'compat-color-mix-fallback',
    Once(root) {
      collectTokens(root)
    },
    Declaration(decl) {
      if (!decl.value.includes('color-mix(')) return
      const calls = findColorMixCalls(decl.value)
      if (calls.length === 0) return
      const rule = decl.parent.type === 'rule' ? decl.parent : null


      // token 定义规则 → 简单降级（保留 var 引用）
      if (rule && isTokenRule(rule.selector || '')) {
        if (!simpleFallback(decl, calls)) decl.remove()
        return
      }

      const lightTables = [lightTokens, baseTokens]
      const darkTables = [darkTokens, baseTokens]
      let value = decl.value
      const lightVals = []
      const darkVals = []
      for (const c of calls) {
        const l = mixToRgba(c.inner, lightTables)
        const d = mixToRgba(c.inner, darkTables)
        if (!l && !d) {
          // 该调用解析失败 → 整条声明回退旧策略（实色）
          if (!simpleFallback(decl, calls)) decl.remove()
          return
        }
        lightVals.push(l ? toRgbaStr(l) : toRgbaStr(d))
        darkVals.push(d ? toRgbaStr(d) : null)
      }
      // 静态求值成功：先用 light 值替换
      for (const c of [...calls].reverse()) {
        const idx = calls.indexOf(c)
        value = value.slice(0, c.start) + lightVals[idx] + value.slice(c.end)
      }
      decl.value = value
      if (rule) {
        let rec = pendingRules.find((r) => r.rule === rule)
        if (!rec) {
          rec = { rule, props: new Map() }
          pendingRules.push(rec)
        }
        rec.props.set(decl.prop, { light: lightVals, dark: darkVals })
      }
    },
    // @supports (color: color-mix(...)) 条件里的 color-mix 也要改写：
    // 兼容产物只服务于不支持 color-mix 的浏览器，条件恒假会导致整块被跳过。
    // 改写为恒真的 "red"，块内的 var()/实色声明即可正常生效。
    AtRule(at) {
      if (at.name === 'supports' && at.params.includes('color-mix(')) {
        const calls = findColorMixCalls(at.params)
        if (calls.length === 0) return
        let params = at.params
        for (const c of [...calls].reverse()) {
          params = params.slice(0, c.start) + 'red' + params.slice(c.end)
        }
        at.params = params
      }
    },
    // 生成 dark 主题规则（html.dark/.dark-theme 后代前缀）；dark 与 light 相同则跳过
    OnceExit() {
      for (const { rule, props } of pendingRules) {
        let hasDark = false
        for (const [, v] of props) {
          if (v.dark.some((s, i) => s && s !== v.light[i])) {
            hasDark = true
            break
          }
        }
        if (!hasDark) continue
        const clone = rule.clone()
        clone.selector = prefixThemeSelector(rule.selector)
        clone.walkDecls((d) => {
          const v = props.get(d.prop)
          if (v) {
            const idx = v.light.indexOf(d.value)
            if (idx !== -1 && v.dark[idx]) d.value = v.dark[idx]
          }
        })
        rule.parent.insertAfter(rule, clone)
      }
    },
  }
}
colorMixFallback.postcss = true

// 常用命名色（覆盖 Radix 色板与项目常用；缺失的解析失败自动回退实色策略）
const NAMED_COLORS = {
  white: { r: 255, g: 255, bl: 255, a: 1 },
  black: { r: 0, g: 0, bl: 0, a: 1 },
  transparent: { r: 0, g: 0, bl: 0, a: 0 },
  red: { r: 255, g: 0, bl: 0, a: 1 },
  green: { r: 0, g: 128, bl: 0, a: 1 },
  blue: { r: 0, g: 0, bl: 255, a: 1 },
  gray: { r: 128, g: 128, bl: 128, a: 1 },
  grey: { r: 128, g: 128, bl: 128, a: 1 },
}

function parseHex(hex) {
  const h = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex
  if (/^[0-9a-f]{6}$/i.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      bl: parseInt(h.slice(4, 6), 16),
      a: 1,
    }
  }
  if (/^[0-9a-f]{8}$/i.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      bl: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    }
  }
  return null
}

function parseRgbArgs(args) {
  const parts = args.split('/')
  const nums = parts[0].trim().split(/[\s,]+/)
  if (nums.length < 3) return null
  const toNum = (s) => {
    if (s.endsWith('%')) return Math.round((parseFloat(s) / 100) * 255)
    return parseFloat(s)
  }
  const r = toNum(nums[0])
  const g = toNum(nums[1])
  const b = toNum(nums[2])
  if ([r, g, b].some((n) => Number.isNaN(n))) return null
  let a = 1
  if (parts[1]) {
    const av = parts[1].trim()
    a = av.endsWith('%') ? parseFloat(av) / 100 : parseFloat(av)
  }
  return { r: Math.round(r), g: Math.round(g), bl: Math.round(b), a }
}

function toRgbaStr(c) {
  const a = Math.round(c.a * 1000) / 1000
  return `rgba(${c.r},${c.g},${c.bl},${a})`
}

// 给选择器加 `.dark / .dark-theme` 后代前缀（postcss-selector-parser 保持转义原样）
function prefixThemeSelector(selector) {
  const ast = selectorParser().astSync(selector)
  return ast.nodes.map((s) => `.dark ${s.toString()}, .dark-theme ${s.toString()}`).join(', ')
}

function findColorMixCalls(value) {
  const out = []
  let i = 0
  while ((i = value.indexOf('color-mix(', i)) !== -1) {
    let depth = 0
    let k = i + 'color-mix'.length
    let closed = -1
    for (; k < value.length; k++) {
      const ch = value[k]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          closed = k
          break
        }
      }
    }
    if (closed === -1) break // 未闭合，放弃
    out.push({ start: i, end: closed + 1, inner: value.slice(i + 'color-mix'.length + 1, closed) })
    i = closed + 1
  }
  return out
}

function splitTopLevel(inner) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of inner) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.map((s) => s.trim()).filter(Boolean)
}

function stripPct(s) {
  return s.replace(/\s+\d+(?:\.\d+)?%$/, '').trim()
}

function colorMixFallbackValue(inner) {
  const parts = splitTopLevel(inner)
  const colors = parts.slice(1) // parts[0] = "in <colorspace>"
  if (colors.length < 2) return null
  const aColor = stripPct(colors[0])
  const bColor = stripPct(colors[1])
  if (aColor === 'transparent') return bColor
  if (bColor === 'transparent') return aColor
  return aColor
}

// ─────────────────────────── 主流程 ───────────────────────────
function buildCompatCss(srcPath) {
  const raw = readFileSync(srcPath, 'utf8')

  // Pass 1: dvh → vh（全文件字符串替换，含 @supports (min-height:100dvh) 条件，行为符合预期）
  let css = raw.replace(/(\d+(?:\.\d+)?)dvh/g, '$1vh')

  // Pass 2: prepend 规范层序声明（无 layer 的 CSS 跳过，避免输出 "@layer ;"）
  const layerNames = KNOWN_LAYERS.filter((n) => css.includes(`@layer ${n}`))
  if (layerNames.length > 0) {
    css = `@layer ${layerNames.join(', ')};\n${css}`
  }

  // Pass 3: :where/:is 展开 → :focus-visible → color-mix 降级
  css = postcss([unwrapWhereIs(), focusVisibleFix(), colorMixFallback()]).process(css, {
    from: undefined,
  }).css

  // Pass 4: @layer 展开（csstools，:not(#\#) 链提升特异性，Safari 9+ 兼容，不引入 :where/:is）
  css = postcss([postcssCascadeLayers()]).process(css, { from: undefined }).css

  return css
}

// 改写 HTML：注入运行时特性检测脚本（幂等：已有标记则跳过）
function injectCompatScript(htmlPath) {
  let html = readFileSync(htmlPath, 'utf8')
  if (html.includes('data-compat-css')) {
    console.log(`[compat-css] 跳过（已注入）：${path.basename(htmlPath)}`)
    return
  }
  const cssLinks = []
  for (const tag of html.matchAll(/<link\s[^>]*>/g)) {
    const href = tag[0].match(/href="([^"]+)"/)?.[1]
    const rel = tag[0].match(/rel="([^"]+)"/)?.[1]
    if (
      rel &&
      rel.includes('stylesheet') &&
      href &&
      href.includes('static/css/') &&
      !href.startsWith('http')
    ) {
      cssLinks.push(href)
    }
  }
  if (cssLinks.length === 0) {
    console.error(`[compat-css] 未找到本地 CSS link：${htmlPath}`)
    return
  }
  const compatLinks = cssLinks.map((h) => h.replace(/\.css$/, '.compat.css'))
  const script = `<script data-compat-css>
/* macOS 10.15-12 兼容样式切换：不支持 color-mix（= Safari < 16.2 = macOS < 13）时改用 compat.css */
(function(){try{
  var ok=window.CSS&&CSS.supports&&CSS.supports('background','color-mix(in srgb, red, blue)');
  if(!ok){
    var ls=document.querySelectorAll('link[rel="stylesheet"]');
    var compat=['${compatLinks.join("','")}'];
    for(var i=0;i<ls.length;i++){
      var h=ls[i].getAttribute('href')||'';
      if(h.indexOf('/static/css/')>=0){ls[i].media='not all';}
    }
    for(var j=0;j<compat.length;j++){
      var c=document.createElement('link');c.rel='stylesheet';c.href=compat[j];
      document.head.appendChild(c);
    }
  }
}catch(e){}})();
</script>`
  html = html.replace('</head>', `${script}\n  </head>`)
  writeFileSync(htmlPath, html)
  console.log(`[compat-css] 已注入特性检测：${path.basename(htmlPath)} → ${compatLinks.join(', ')}`)
}

// ─────────────────────────── JS 整包转译（esbuild → es2020） ───────────────────────────
// Rsbuild 的 swc 规则默认排除 node_modules，依赖 dist 里的 ES2022 语法
// （class 私有字段 / static block / 公共字段）会原样进 bundle，Safari 13.1 整包解析失败。
// 构建后回写转译版本：新旧系统行为一致，仅去掉旧 WebKit 不认识的语法。
// 目标用 es2020 而非 safari13：esbuild 无法把解构降级到 safari13/14 目标（会直接报错），
// 而 es2020 输出（可选链/空值合并保留）恰好是 Safari 13.1 支持的上限。
async function buildCompatJs(jsPath) {
  const src = readFileSync(jsPath, 'utf8')
  const result = await esbuild.transform(src, {
    target: 'es2020',
    minify: true,
    legalComments: 'inline',
    logLevel: 'silent',
  })
  writeFileSync(jsPath, result.code)
  const sizeMB = (result.code.length / 1024 / 1024).toFixed(1)
  console.log(`[compat-js] ✓ ${path.basename(jsPath)} → es2020 转译 (${sizeMB}MB)`)
}

// ─────────────────────────── 执行 ───────────────────────────
const cssFiles = readdirSync(cssDir).filter(
  (f) => f.endsWith('.css') && !f.endsWith('.compat.css'),
)
if (cssFiles.length === 0) {
  console.error(`[compat-css] ${cssDir} 下无 CSS 产物`)
  process.exit(1)
}
for (const f of cssFiles) {
  const src = path.join(cssDir, f)
  const dst = path.join(cssDir, f.replace(/\.css$/, '.compat.css'))
  const out = buildCompatCss(src)
  writeFileSync(dst, out)
  const sizeMB = (out.length / 1024 / 1024).toFixed(1)
  console.log(`[compat-css] ✓ ${f} → ${path.basename(dst)} (${sizeMB}MB)`)
}

for (const htmlName of ['index.html', 'options.html']) {
  const p = path.join(distDir, htmlName)
  if (existsSync(p)) injectCompatScript(p)
}

// JS 转译在 CSS/HTML 注入之后（互不依赖，顺序无所谓）
const jsFiles = readdirSync(distDir).filter((f) => f.endsWith('.js') && !f.endsWith('.LICENSE.txt'))
for (const f of jsFiles) {
  await buildCompatJs(path.join(distDir, f))
}

console.log('[compat] 完成')
