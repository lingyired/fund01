# Permission Justification — fund01 基金盯盘 (Fund01 Fund Tracker)

**Extension Name:** fund01 基金盯盘
**Manifest Version:** 3

The extension requests the **minimum set of permissions** required to deliver its functionality. Every permission is justified below.

---

## 1. `storage`

**Purpose:** Persist the user's fund holdings, grouping and display settings (groups, order, theme, refresh preferences), and locally cached market quotes so data survives across sessions.

**Why it is needed:** The extension cannot function without durable local persistence. All data is stored locally on the user's device (`chrome.storage.local`); nothing is transmitted anywhere.

## 2. `alarms`

**Purpose:** Power the extension's core "always up-to-date" watchlist behavior — automatically refresh fund valuations, index & gold quotes, and portfolio P&L in the background, so the popup always shows the latest numbers the moment the user opens it, with zero manual action required.

**Why it is needed (functional):** The extension's core value is real-time fund monitoring. Fund NAV estimates change continuously during the trading session, and the user expects to open the extension at any time and see current numbers — requiring the user to press "refresh" would defeat the purpose of a fund watchlist. The `alarms` API is how the extension implements this background refresh: Chrome wakes the service worker on schedule and runs the refresh reliably and battery-efficiently. Alarms perform no action other than triggering a data refresh at the interval chosen by the user's settings.

## 3. Host permissions (read-only access to public market data endpoints)

**Purpose:** Fetch **publicly available market data only** — fund NAV estimates, index quotes, and gold prices — to display in the extension's popup.

**What is sent:** Requests contain only necessary public identifiers, such as fund codes (e.g., "008987"). The extension **never** writes data to these hosts, never authenticates, never sends cookies, and never transmits any personal or user-configuration data.

| Host | Purpose |
|---|---|
| `fundmobapi.eastmoney.com` | Real-time fund estimated NAV (intraday valuation) API |
| `fund123.cn` | Fund NAV / historical NAV data (fallback source) |
| `push2.eastmoney.com`, `push2delay.eastmoney.com`, `82.push2.eastmoney.com`, `push2his.eastmoney.com` | A-share index quotes, gold quotes, and historical quote data |
| `emdatah5.eastmoney.com` | Index quote data |
| `web.ifzq.gtimg.cn` | Supplemental market quotes (indices) |
| `hq.sinajs.cn` | A-share index quotes |
| `api.jijinhao.com`, `money.finance.sina.com.cn`, `stock.finance.sina.com.cn` | Fund NAV / quote fallback sources |

## 4. Permissions the extension does NOT request

The extension requests **no** other permissions: no `tabs`, no clipboard access, no notifications, no browsing history, no identity, no cookies, no geolocation. All features are delivered with the minimal permission set listed above.

## 5. Data handling summary

- All user data (holdings, settings, caches) is stored **locally only**.
- No data is transmitted to the developer or to any third party.
- The extension's only network activity is reading public market quotes from the hosts listed above.

## 6. Remote code statement

**The extension does NOT use remote code.** Evidence:

- The manifest declares a strict Content Security Policy: `"script-src 'self'; object-src 'self'"` — extension pages can only execute scripts bundled with the package; loading or executing any external script is blocked by the browser.
- All HTML pages reference only local, packaged scripts (`/popup.js`, `/options.js`, `background.js`). No remote `<script src>`, no remote `<iframe>`, and no dynamic `import()` of remote URLs.
- No `eval()` is used anywhere in the extension code.
- The only network activity is `fetch`-style **data** requests to public quote APIs (see Section 3); fetched responses are data for display, never executed as code.
- All functionality ships inside the CRX/package and is fully reviewable by the store.
