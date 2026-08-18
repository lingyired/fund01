---
name: chrome-options-page
description: Extract settings / management UIs out of a Chrome MV3 popup into a
  native options page (options_ui + open_in_tab), and wire multiple HTML entry
  points correctly in rsbuild. Use when a popup is too heavy, loses state when
  switched away, or settings should be a persistent tab. Also covers the rsbuild
  multi-page HTML template pitfall.
agent_created: true
disable-model-invocation: true
---

# Chrome MV3: native options page + rsbuild multi-page

Move heavy / stateful settings (个人设置、持仓编辑、导入、添加、分组、备份) out of the
popup into a standalone options page that stays open as a tab. Popup keeps only
refresh / theme / open-in-tab / a settings gear.

## When to use
- Popup disappears when user switches tools → editing state lost (e.g. pasting holdings from elsewhere).
- Want a simpler popup.
- Planning a Tauri version where settings must also be a separate surface (architecture-forward reuse).

## Decision
- Chrome native `options_ui` with `open_in_tab: true` (auto-reuses the already-open options tab).
- Put the settings UI in the shared UI package (`packages/ui`), NOT in `apps/chrome`, so Tauri reuses it via `PortsContext` + a swapped Port implementation.

## Steps
1. **Extract pure logic** from the popup dialogs into `lib/*.ts` (e.g. `importHoldings.ts`, `batchEdit.ts`) so the options page and any remaining popup dialogs share it.
2. **Refactor shared form components** to expose a reusable body (e.g. `FundFormBody`) usable both inline (options page, always mounted) and wrapped in a `Dialog` (popup add-watchlist). Do NOT delete a component still referenced elsewhere (e.g. `WatchlistModule` may still use a dialog).
3. **Create `OptionsApp`** in the shared UI package: left nav (`aside`, `w-60 border-r`) + right scrollable content (`main overflow-y-auto`, `mx-auto max-w-3xl space-y-8`), each section a `SectionCard` with `id={`section-${id}`}` + `scrollMarginTop` for anchor scrolling.
   - ⚠️ **`OptionsApp` must wrap its own root in `<Theme accentColor="blue" grayColor="gray" radius="small">`** — Radix components (Button/Select/Tabs/…) call `useThemeContext` and throw a white-screen error if no `<Theme>` ancestor. Self-wrap so Tauri reuse also works; the entry only injects Ports. Do NOT import `Theme` from `@radix-ui/themes` inside `apps/chrome` (not a direct dep → pnpm `Cannot find module`); import it inside `packages/ui`.
   - ⚠️ **Do NOT lock height for an `open_in_tab` options page (the popup pattern breaks here).** A full-tab settings page should follow the **natural document flow** and let the *browser* scroll — not a 100vh shell with an internal scroll container. The wrong pattern (`<div className="flex h-full …">` + `<main className="flex-1 overflow-y-auto">` + `html,body,#root{height:100%!important;overflow:hidden}`) produced a half-screen + blank-below bug: the locked body hid overflow, `scrollIntoView` scrolled the document instead of an inner container, and the page only showed half. Correct layout:
     - `apps/chrome/src/options/index.html`: just `html,body,#root{margin:0}` — **no** `height:100%!important`, **no** `overflow:hidden`.
     - Shell: `<div className="flex bg-paper text-ink">` (no `h-full` / `overflow-hidden`).
     - Sidebar: `<aside className="sticky top-0 h-screen w-60 shrink-0 border-r border-line/70 bg-panel/60">` (natural nav, no inner `overflow-y-auto`); `h-screen` makes the sidebar span the viewport while the document scrolls.
     - Content: `<main className="min-w-0 flex-1">` with inner `<div className="mx-auto max-w-3xl space-y-8 px-6 py-8">` — **no** `overflow-y-auto`, **no** `min-h-0`. The whole page grows with content and scrolls natively; nav `scrollIntoView` scrolls the window correctly.
     - Add `.h-screen{height:100vh}` to `tw-shim.css` if missing (Radix Themes does NOT define it; Tailwind was removed). Also confirm `sticky`/`top-0`/`w-60`/`border-r`/`min-w-0` are present in the shim.
4. **Create the options entry** `apps/chrome/src/options/index.tsx`: `initTheme()` → inject the three Ports → `<PortsContext.Provider><OptionsApp/></PortsContext.Provider>`. Import `OptionsApp, PortsContext, initTheme` from the shared UI package. Do NOT add a `<Theme>` here (OptionsApp self-wraps).
5. **Create `apps/chrome/src/options/index.html`** as a NATURAL full-page document — **do NOT** set `height:100%!important` / `overflow:hidden` (that's popup-only and caused a half-screen-blank bug). Just `html,body,#root{margin:0}` (+ the Google Fonts `<link>`); let the document scroll natively.
6. **Popup gear** → `onOpenSettings={() => chrome.runtime.openOptionsPage()}`; slim `App.tsx` to drop the old dialogs/menus.
7. **Manifest**: add `"options_ui": {"page": "options.html", "open_in_tab": true}`. `copy-manifest.mjs` overwrites `version` from `package.json`, so the literal manifest version is irrelevant.
8. **rsbuild multi-page** — see the pitfall below.
9. **Verify**: `pnpm -r typecheck` (all green) + `pnpm --filter @fund01/chrome build`. Confirm `dist/options.html` exists and references `/options.js`, `options_ui` is in `dist/manifest.json`, and `background.html` was removed.

## ⚠️ rsbuild multi-page HTML pitfall (cost a broken build)
`source.entry` object values follow **Rspack's `EntryDescription`**: the key is `import` (**not `entry`**), and there is **no `html` field**. Writing
`{ entry: './src/options/index.tsx', html: './src/options/index.html' }` is silently ignored →
rsbuild emits **only HTML, no JS**; the build "succeeds" but the extension is unusable.

Correct pattern — keep `source.entry` as **string** entry names, and select each page's
template via a **function** on `html.template` / `html.title`:

```ts
source: {
  entry: {
    background: './src/background/index.ts', // MV3 SW; generates background.html (cleaned later)
    popup: './src/popup/index.tsx',
    options: './src/options/index.tsx',
  },
},
html: {
  template: ({ entryName }) =>
    entryName === 'options' ? './src/options/index.html' : './src/popup/index.html',
  title: ({ entryName }) =>
    entryName === 'options' ? 'fund01 · 设置' : `fund01 · 基金盯盘 v${pkg.version}`,
},
```

`copy-manifest.mjs` removes the orphan `background.html`. With `chunkSplit: { strategy: 'all-in-one' }` each entry yields a single JS file (`popup.js`/`options.js`) plus its own full CSS (~705KB, Radix whole styles) — expected.

## Tailwind-removed caveat
This project removed Tailwind; every utility class must be a real Radix Themes class or exist in
`packages/ui/src/tw-shim.css` (slash-alpha like `bg-accent/10` use `color-mix`). Unknown classes
silently get no styles. Grep `tw-shim.css` before adding new utilities.
