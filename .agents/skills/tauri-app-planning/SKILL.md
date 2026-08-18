---
name: tauri-app-planning
description: Comprehensive project planning, requirements analysis, and
  architectural orchestration for Tauri 2.0 applications.
license: Complete terms in LICENSE.txt
disable-model-invocation: true
---

# Tauri App Planning

This skill acts as a Senior Architect for Tauri projects. It guides the user from vague requirements to a concrete implementation plan, integrating technical orchestration patterns.

## When to use this skill

**ALWAYS use this skill when the user:**
- Wants to start a new Tauri project.
- Asks for a "plan", "roadmap", or "architecture" for a Tauri app.
- Needs to analyze requirements and map them to specific Tauri features/plugins.
- Asks about "orchestrating" windows, state, or events in Tauri.

## Workflow

1.  **Requirement Analysis**: Clarify what the user wants to build (Platforms, Core Features, UI Framework).
2.  **Technical Planning**:
    -   Select necessary `tauri-app-*` skills/plugins.
    -   Define Architecture (Monolith vs Sidecar, Multi-window topology).
    -   Define Security Scope (Capabilities).
3.  **Orchestration Design**:
    -   State Management Strategy (Rust vs Frontend).
    -   Event Communication Patterns.
4.  **Execution Plan**:
    -   Generate a step-by-step Todo List using the `TodoWrite` tool.

## Outputs

- **Technical Design Document**: A Markdown document outlining the stack, plugins, and architecture.
- **Todo List**: A structured list of tasks to build the project.

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
