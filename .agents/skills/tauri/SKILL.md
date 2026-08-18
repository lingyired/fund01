---
name: tauri
description: Comprehensive index for Tauri framework development, including Rust
  backend, frontend integration, and full plugin ecosystem. Acts as a router to
  specialized sub-skills with local examples and templates.
license: Complete terms in LICENSE.txt
disable-model-invocation: true
---

## When to use this skill

Use this skill as the **primary entry point** for any Tauri-related request. It serves as a "Total Index" (like `nvm`) that routes you to specific sub-skills.

**Why?**
- **Token Efficiency**: Each sub-skill contains local `examples/` and `templates/` directories, providing detailed, offline-ready documentation without expensive network searches.
- **Tauri v2 Ready**: All sub-skills are updated for Tauri v2.0+ (plugins, capabilities, permissions).

## How to use this skill

1.  **Identify Intent**: Determine if the user needs setup, specific plugin functionality (FS, Dialog, SQL), or core app configuration.
2.  **Route**: Invoke the specific sub-skill listed below.
3.  **Explore**: Inside the sub-skill, use `examples/usage.md` for step-by-step guides and `templates/capabilities.json` for permission configs.

### Sub-skill Map

**Planning & Architecture**
- `tauri-app-planning`: **START HERE**. Requirement analysis, plugin selection, architecture design, and Todo list generation. Includes orchestration patterns.

**Core & Lifecycle**
- `tauri-setup`: Project initialization and environment setup.
- `tauri-scaffold`: Creating files and structures.
- `tauri-app-develop`: Development workflow (dev, build, debug).
- `tauri-app-process`: Process management and exit handling.
- `tauri-app-updater`: Auto-update configuration and API.
- `tauri-mobile`: Android and iOS specific development.

**System Integration**
- `tauri-app-shell`: Spawn sidecars and run system commands.
- `tauri-app-os-info`: Get OS version, arch, and locale.
- `tauri-app-clipboard`: Read/write to system clipboard.
- `tauri-app-dialog`: Native file open/save dialogs and message boxes.
- `tauri-app-notification`: System notifications.
- `tauri-app-global-shortcut`: Register system-wide keyboard shortcuts.
- `tauri-app-autostart`: Launch app on system login.
- `tauri-app-biometric`: TouchID/FaceID authentication.
- `tauri-app-opener`: Open URLs/files in default apps.
- `tauri-app-deep-linking`: Handle custom protocol links (e.g., `myapp://`).

**Data & Networking**
- `tauri-app-http-client`: Rust-based HTTP client (CORS-free).
- `tauri-app-websocket`: WebSocket client.
- `tauri-app-upload`: File upload utility.
- `tauri-app-sql`: SQLite, MySQL, PostgreSQL database access.
- `tauri-app-store`: Simple persistent key-value store.
- `tauri-app-stronghold`: Secure secret management and encryption.
- `tauri-app-file-system`: Read/write files (sandboxed).

**Window & UI**
- `tauri-app-window-menu`: Native application menus and context menus.
- `tauri-app-system-tray`: System tray icon and menu.
- `tauri-app-window-state`: Persist window size/position.
- `tauri-app-positioner`: Tray and window positioning.
- `tauri-app-single-instance`: Prevent multiple app instances.

## Examples and Templates

**Global Examples** (General Architecture)
- `examples/start/`: Introduction and Quick Start.
- `examples/guide/`: Architecture, Frontend/Backend patterns.

**Sub-skill Examples** (Specific Features)
**CRITICAL**: Every sub-skill above has its own local assets.
- `skills/tauri-app-dialog/examples/usage.md`: detailed Dialog plugin usage.
- `skills/tauri-app-sql/examples/usage.md`: detailed SQL plugin usage.
- `...` and so on for all skills.

## Keywords

Tauri, tauri v2, rust, desktop app, mobile app, plugins, capabilities, permissions, system tray, notifications, file system, database, sql, http, websocket, updater, sidecar, ipc, events, commands, window customization

## References

- https://v2.tauri.app/llms.txt

## 国内适配

- 支持中文文档和中文注释
- 示例代码兼容国内开发环境
- 提供中文 FAQ 和常见问题解答

## 能力边界

### ✅ 适用场景
- 当你需要使用此技能对应的技术栈时
- 当项目需要遵循最佳实践时
- 当需要快速上手或深入理解核心概念时

### ⚠️ 需要注意
- 复杂业务逻辑需要结合具体场景调整
- 性能优化需要根据实际数据量评估

### ❌ 不适用场景
- 不相关的技术栈或框架
- 需要完全自定义的特殊场景

## 使用流程

### Step 1: 环境准备
确保开发环境已安装必要的依赖和工具。

### Step 2: 配置初始化
根据项目需求进行基础配置。

### Step 3: 核心功能使用
按照示例代码实现核心功能。

### Step 4: 测试验证
运行测试确保功能正常。

### Step 5: 部署上线
完成开发后进行部署和监控。
