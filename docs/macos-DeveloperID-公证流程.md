# macOS Developer ID 签名 + 公证 —— 完整流程

**日期**：2026-10-11
**目的**：让 Fund01 桌面版能自动更新（未公证的包会被 Gatekeeper 拦，updater 替换 `.app` 后用户打不开）
**当前状态**：代码侧全部就绪（CI run 38147728440 全绿），只差证书与公证

---

## 0. 你要先搞清两件事的区别

| | 作用 | 现在有没有 |
|---|---|---|
| **Developer ID Application 证书** | 证明「这包是 App Store 之外的正式分发」 | ❌ 只有自签 `Fund01` |
| **Notarization（公证）** | Apple 服务器验证包没被篡改，出一个「已通过 Apple 公证」记录 | ❌ 完全没有 |

**公证是硬门槛。** 官方原文：*"Notarization is required when using a Developer ID Application certificate."*

只有证书不公证，用户装完照样要看「已损坏」（现在要 `xattr -rd com.apple.quarantine` 的那个问题）。

> ⚠️ 顺带纠正一个常见误解：**免费账号无法公证**，也不能创建 Developer ID Application 证书。
> 必须付费的 Apple Developer Program（$99/年）。

---

## 1. Apple Developer 后台操作

### 1.1 创建 Developer ID Application 证书

**入口**：https://developer.apple.com/account/resources/certificates/list → `Create a certificate`

⚠️ **两个容易选错的点**：
- 选 **`Developer ID Application`**，不是 `Apple Distribution`（后者是给 App Store 上架的）
- **只有 Account Holder 能创建**这个类型的证书。如果你账号是 Admin/Member，需要让 Account Holder 登录操作，或者让他把权限提上来

### 1.2 先在 Mac 上生成 CSR

Apple 需要你上传 CSR 才能签发证书。

```bash
# 钥匙串访问 → 我的证书 → 右键 → 生成证书助理 → 证书助理
# 或命令行（推荐，指定 CN）
openssl req -new -newkey rsa:2048 -nodes \
  -keyout ~/Desktop/fund01-devid.key \
  -out ~/Desktop/fund01-devid.csr \
  -subj "/CN=Developer ID Application: lingyired (TEAMID)"
```

> `TEAMID` 在 https://developer.apple.com/account → Membership 信息里能看到。
> 记下这个 10 位团队 ID，后面公证要用。

### 1.3 上传 CSR、下载证书

`Create a certificate` → 选 `Developer ID Application` → 上传 `.csr` → 证书生成后点 Download。

拿到 `Developer ID Application: xxx (TEAMID).cer`。

**双击安装到钥匙串**（或见下一步的导出流程）。

### 1.4 创建 App Store Connect API Key

**入口**：https://appstoreconnect.apple.com/access/users → 选 `Integrations` 标签 → `+` → 选 `App Store Connect API` → 填名称 → 选 `Developer` 权限 → Create

拿到三个值，**记下来**（私钥只能下载一次）：

| 值 | 从哪来 | 对应环境变量 |
|---|---|---|
| Issuer ID | keys 表格**上方**那串 UUID | `APPLE_API_ISSUER` |
| Key ID | keys 表格 **Key ID** 列 | `APPLE_API_KEY` |
| 私钥 `AuthKey_XXX.p8` | 点下载（刷新页面后按钮消失） | `APPLE_API_KEY_PATH`（文件路径） |

> **为什么用 API Key 而不是 Apple ID + App 专用密码**：
> Apple ID 方式需要开启两步验证，密码轮换会让 CI 突然失效；API Key 不会。
> 官方也优先推荐这个方式。

---

## 2. 导出证书给 CI 用

### 2.1 导出 p12

**钥匙串访问** → `我的证书` → 找到 `Developer ID Application: xxx` → 展开 → 右键**私钥** → 导出 → 存为 `.p12` → 设密码

```bash
# 转 base64（GitHub Secrets 要的就是这个）
openssl base64 -A -in ~/Desktop/fund01-devid.p12 -out ~/Desktop/fund01-devid-base64.txt

# 顺便备份私钥（重要，后面重新签发要用）
cp ~/Desktop/fund01-devid.key ~/secure-backup/
```

### 2.2 设 GitHub Secrets

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/lingsmbp/Documents/aiwork/fund01

# 替换现有自签证书
gh secret delete MACOS_CERT_P12
gh secret delete MACOS_CERT_PASSWORD

gh secret set MACOS_CERT_P12 < ~/Desktop/fund01-devid-base64.txt
gh secret set MACOS_CERT_PASSWORD <<< '你导出 p12 时设的密码'

# 新增公证相关
gh secret set APPLE_API_ISSUER <<< 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
gh secret set APPLE_API_KEY <<< 'ABCDE12345'          # Key ID，用作 p8 文件名
gh secret set APPLE_API_KEY_CONTENT < ~/Desktop/AuthKey_ABCDE12345.p8
```

> ⚠️ **注意 secret 名字的选择**：`APPLE_API_KEY` 官方定义是 **Key ID**（不是私钥内容）。
> 而 `APPLE_API_KEY_PATH` 是**文件路径** —— GitHub secret 只能存字符串，存不了文件。
> 所以额外开一个 `APPLE_API_KEY_CONTENT` 存 p8 内容，CI 里先落盘再指路径（见 §4.2）。

`TAURI_SIGNING_PRIVATE_KEY`（updater 签名用）**保持不动**，它是另一把钥匙，跟 Apple 无关。

---

## 2.5 ⭐ 别漏了 hardened runtime

Tauri 启用 Developer ID 签名时，macOS 会要求 **hardened runtime**。没有它，Apple 会拒绝公证。

好消息：Tauri v2 默认就开着，通常不需要手动配。但如果你遇到公证被拒（错误码里提到
`hardened runtime` 或 `The signature does not include a secure timestamp`），在
`tauri.conf.json` 里显式加上：

```json
"macOS": {
  "minimumSystemVersion": "13.0",
  "signingIdentity": "-",
  "hardenedRuntime": true
}
```

Fund01 用 WebView + `macOSPrivateApi`，目前没报过这个问题，但公证被拒时这是第一个要查的点。

---

## 3. 本机先验证（不依赖 CI）

先在自己机器上确认证书能用，避免改完 CI 才发现证书有问题。

```bash
# 确认证书在钥匙串里且有效
security find-identity -v -p codesigning

# 应该看到类似：
# 1) A1B2C3... "Developer ID Application: lingyired (XXXXXXXXXX)"
```

如果看不到 → 证书没装好，或「钥匙串访问 → 默认钥匙串」里没勾选 `login`。

```bash
cd /Users/lingsmbp/Documents/aiwork/fund01-updater/apps/tauri

# 带 Developer ID 构建 + 公证（首次可用 --skip-stapling 缩短等待）
APPLE_SIGNING_IDENTITY="Developer ID Application: lingyired (XXXXXXXXXX)" \
APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
APPLE_API_KEY="ABCDE12345" \
APPLE_API_KEY_PATH="/path/to/AuthKey_ABCDE12345.p8" \
pnpm exec tauri build --bundles dmg --skip-stapling
```

公证要 2-5 分钟，Apple 会把你的 app 扫一遍。有问题会明确报错。

---

## 4. 代码改动（我做）

### 4.1 `tauri.conf.json`

```json
"macOS": {
  "minimumSystemVersion": "13.0",
  "signingIdentity": "-"      // 保持不变
}
```

**为什么不改**：本机开发仍用 ad-hoc（快、免证书），CI 用 `APPLE_SIGNING_IDENTITY` env 覆盖
——这是 Tauri 的优先级规则（env 高于 conf），也是你们现有做法。

### 4.2 CI 新增步骤

```yaml
- name: Write App Store Connect API key
  env:
    APPLE_API_KEY_CONTENT: ${{ secrets.APPLE_API_KEY_CONTENT }}
  run: |
    # p8 是文件内容不是路径，先落盘再让 tauri 读
    echo "$APPLE_API_KEY_CONTENT" > "$RUNNER_TEMP/AuthKey_${{ secrets.APPLE_API_KEY }}.p8"
    echo "APPLE_API_KEY_PATH=$RUNNER_TEMP/AuthKey_${{ secrets.APPLE_API_KEY }}.p8" >> "$GITHUB_ENV"

# Build 步骤 env 追加公证变量
env:
  APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
  APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
  APPLE_API_KEY_PATH: ${{ env.APPLE_API_KEY_PATH }}
```

> 💡 建议 secret 拆成 `APPLE_API_KEY`（Key ID）和 `APPLE_API_KEY_CONTENT`（p8 内容）两个，
> 前者拼文件名，后者写内容。比单个 `APPLE_API_KEY_PATH` 更好用。

**CI 现有的证书导入步骤不用改** —— 你们那套 keychain 逻辑（`-A` 导入、`set-key-partition-list`、
build 前二次 unlock）是踩坑调出来的，换证书内容即可复用。

---

## 5. 验收标准

### 5.1 公证生效

```bash
# 对产物查公证状态
spctl -a -vvv -t install /Applications/Fund01.app
# 期望：accepted, source=Notarized Developer ID

# 或
xcrun stapler validate /Applications/Fund01.app
# 期望：The validate action worked!
```

### 5.2 用户侧（最关键）

1. 挂载 dmg，把 Fund01 拖到「应用程序」
2. **双击直接打开**
3. 右键 → 关于本机 → 签名应显示 **「已通过 Apple 公证」**
4. **不再需要** `xattr -rd com.apple.quarantine`

### 5.3 自动更新端到端

1. 装 1.7.0（公证版）
2. 用应用内「立即更新」升到 1.7.1（公证版）
3. 更新后 app 能正常打开、菜单栏正常、无「已损坏」

---

## 6. 常见坑

| 现象 | 原因 | 解法 |
|---|---|---|
| `No Developer ID certificates found` | 证书没导入或钥匙串不对 | `security find-identity -v -p codesigning` 确认 |
| CI 卡死在 "replacing existing signature" | 钥匙串 ACL 未放行 | 你们已修（`-A` 导入 + build 前二次 unlock） |
| `Invalid private key` / p8 读不到 | `APPLE_API_KEY_PATH` 指向不存在文件 | 先落盘再 export 到 GITHUB_ENV |
| 公证返回 `502` / 超时 | Apple 服务繁忙 | 重跑；`--skip-stapling` 可先跳过 stapling 阶段 |
| 本地公证过但 CI 不过 | CI 缺公证 env | 检查 4 个 env 都传了 |
| `Only Account Holder can create...` | 权限不足 | 让 Account Holder 操作 |
| 证书下载后钥匙串看不到 | `login` 钥匙串没勾选 | 钥匙串访问 → 默认钥匙串 → 勾 `login` |

---

## 7. 发布（公证通过后）

```bash
export PATH="/opt/homebrew/bin:$PATH"

# 1. 建 Release 并挂产物（CI artifact 里有）
gh release create v1.7.0 \
  release-macos/*.dmg \
  release-macos/SHA256SUMS.txt \
  dist-updater-macos/latest.json \
  --title "Fund01 v1.7.0" --notes "支持应用内自动更新"

# 2. 同步 lingai.net 版本接口（两套都要）
cd /Users/lingsmbp/Documents/workspace/lingai-server/lingai.net
bash api/bump-version.sh fund01 1.7.0
bash api/bump-version.sh fund01 1.7.0 macos
# ⚠️ 线上服务改动，需 ling 人工执行，agent 不代跑
```

> `latest.json` 挂 Release 资产后，端点 2/3 就能用了（`releases/latest/download/latest.json`）。

---

## 参考

- Tauri macOS 签名文档：https://v2.tauri.app/distribute/sign/macos/
- Apple 证书后台：https://developer.apple.com/account/resources/certificates/list
- App Store Connect API Key：https://appstoreconnect.apple.com/access/users
- 项目 spec：`docs/superpowers/specs/2026-10-11-在线更新自动更新-design.md`