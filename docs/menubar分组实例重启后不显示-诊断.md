# menubar 分组实例重启后不显示 —— 诊断记录（已修复）

> 状态：**已修复**（2026-08-10 完成，分支 `fix/menubar-visible-model`，`cargo check` + `cargo test --lib` 通过；**同日 macOS 真机实测确认**：重启后分组正常显示、⌘-拖出后设置页勾选实时取消、普通开关即时响应）
> 根因：自造的「显隐 = 实例销毁重建」churn，叠加原生 setter 异步 / getter 同步不对称，导致重启后分组实例被 macOS 布局簿记错乱到屏幕外（y=-22）。
> 对照插件 demo 的合并模型（实例仅 create 一次、显隐只走 `set_visible`、只有分组删除才 `remove`）完成改造。

---

## 〇、根因与修复（2026-08-10 已修复，取代下方「未解之谜」）

### 根因（三层，从前到后叠加）

1. **架构层**：我们把「显隐」编码成「实例存不存在」——隐藏分组 → `remove` 实例，显示分组 → 重新 `create`。而插件 `multiline_menubar.mm` 注释明示 macOS 13+ 用 `statusItem.visible` 而非 `removeStatusItem`，正是因为 **`removeStatusItem` loses position**（位置靠系统运行时簿记，不写 autosaveName）。销毁重建必然丢位置。
2. **引爆点（最致命）**：插件原生层 setter（`create`/`show`/`hide`/`set_*`）全部 `dispatch_async(main)` **异步入队**；而 getter（`is_visible`/`get_rect`）用 `run_on_main_sync` **同步立即执行**。`lib.rs:78` 在 **主线程** `setup` 阶段 `rebuild_menubar` → `create` 入队后**同一 runloop turn 内**就同步回读 `is_visible` → 此刻 `g_instances[key]` 还是 nil → 恒定 `false` → 误判「不可见」→ 强制 `set_visible(true)` + 销毁重建。一个 turn 内 6 个实例齐做 churn，macOS 布局簿记彻底错乱 → 分组被推到 `y=-22`（屏幕外）。
3. **自激层**：78ba060 的「屏幕边界校验」把 `y=-22` 判为「不可见」→ 又触发销毁重建 → 更乱 → `spawn_startup_recovery` 再追加 6 轮 killall。**补丁在喂养病因**，所以用户复测「还是一样」。

### 修复（完整改造，对齐插件 demo INTEGRATION-NOTES / examples/demo）

- **合并模型**：`desired_instances` 返回**全集**（`Vec<InstanceSpec>`，含 `visible` 字段）；隐藏分组照样进列表，仅 `visible=false`。总览恒 `visible=true`。
- **`sync_instances` 三步**：① `tracked().insert()` 去重守卫下 `create` 缺失实例（一次终生不销毁）；② **对每个实例 `set_visible(id, spec.visible)` 声明式下发**——显隐唯一通道，不销毁不重建；③ 仅销毁「不该存在」的 stale id（分组被删除 / 未分组消失）。
- **删除全部自激代码**：`instance_is_visible` / `ensure_instance_visible` / `destroy_instance` / `spawn_startup_recovery`（含 `STARTUP_RECOVERY_DONE` AtomicBool、`killall SystemUIServer`）整段移除；`REMOVED_BY_USER` / `removed_by_user()` / `AtomicBool` 导入一并删除。
- **`update_menubar`**：删除回读 `is_visible` 的自愈循环与 `recreated` 重建分支，显隐只在 `sync_instances` 内 `set_visible` 下发；结尾循环改为 `for spec in desired` 按字段访问。
- **`ensure_remove_listener`**：⌘-拖出语义对齐 demo = 「取消勾选」——只写 `menubarHiddenGroups` + persist + `rebuild_menubar`（`desired` 里该分组变 `visible=false` → `set_visible(false)`，实例保留原位可复活），不再写 `removed_by_user` 标记。
- **验证**：`cargo check` ✅、`cargo test --lib` ✅（10 passed / 3 ignored 网络探针）。**重启验证由用户手动进行**（应用不在此环境启动）。

### 为何重启后分组现在能显示

`setup()` 主线程 `rebuild_menubar` → `sync_instances`：`create`（异步入队）+ `set_visible`（异步入队，FIFO 紧随其后），**全程不再同步回读 `is_visible`**。create 与 set_visible 都在 main queue 顺序执行，原生层有机会真正建出 NSStatusItem 后再设可见性；系统运行时簿记不再被打断，位置（含用户 ⌘-拖拽结果）完整保留。

---

- **重启（重新运行）应用后**，菜单栏只有「总览（全部）」一个实例，**设置页勾选为显示的分组实例全部不出现**（约 5~6 个分组）。
- 系统设置 → 控制中心 → 菜单栏 里 fund01-tauri **只有一个 app 级开关且已勾选**（没有 per-item 开关）——否则总览也无法显示。
- 运行中通过设置页开关分组（显示/隐藏）时，数据链路正确（见下），但重启后分组实例集体失踪。
- 应用运行期间手动 ⌘-拖出某个实例，目前会正常写入 menubarHiddenGroups（3fdade5），但重启场景是独立问题。

## 二、已确认的事实（日志证据）

### 2.1 数据链路已 100% 正确（前几轮修复完成）

```
[fund01][web] toggleGroup group=重复基金 show=false cur=[...] next=[...]   ← 点哪个分组就操作哪个
[fund01] save_config: menubarHiddenGroups [...] -> [...]                    ← 写入与点击一致
[fund01] sync_instances created=[...] removed=[menubar-group-xxx]           ← 实例增删与写入一致
```

- 落盘配置核对：`holdingGroups` 7 个分组无重名；`menubarHiddenGroups` 与设置页一致。
- 相关修复：开关写入串行化 + 300ms 保存禁用（609bef1/1d1c7fd）、Tauri 配置镜像乐观同步（fb201ed）。

### 2.2 重启后实例状态（关键诊断数据）

启动日志（旧版可见性判定时）：

```
[fund01] sync_instances created=[menubar-overview, menubar-group-...×5] removed=[]
[fund01] 实例 menubar-overview 当前不可见 → set_visible(true) 无效 → 销毁重建 → 仍不可见
[fund01] 实例 menubar-group-xxx 当前不可见 → set_visible(true) 无效 → 销毁重建 → 仍不可见   （×5）
[fund01] 启动实例恢复成功（第 1 次尝试）      ← 700ms 延迟重试后，is_visible + rect 全部通过
```

**rect 诊断（决定性证据）**——屏幕 2048x1152（逻辑）：

```
[fund01] 诊断 menubar-overview rendered=true raw_visible=true rect=(1278,1126) 48x22   ← 正常，在顶部菜单栏
[fund01] 诊断 menubar-group-xxx     rendered=true raw_visible=true rect=(8,-22) 48x22    ← 异常，y=-22 在屏幕底部之外
[fund01] 诊断 menubar-group-xxx     rendered=true raw_visible=true rect=(8,-22) 48x22    （全部 5 个分组同样）
```

**结论：`statusItem.visible=true` 且 rect 非零，但分组实例被 macOS 定位到屏幕外（y=-22，即屏幕底部下方 22pt）——所以视觉上完全不显示。** 总览位置正常（y=1126）。

### 2.3 macOS 侧机制（查证）

- macOS 13+ 对第三方 status item 有「用户移除记忆」，重启后可能压制实例；恢复 = 显式 `visible=true`，仍无效则销毁重建全新 NSStatusItem（此前总览靠「700ms 延迟重试」成功恢复，见 3419fa0）。
- 本项目插件（`lingyired/tauri-plugin-multiline-menubar` v1.6.0）无 autosaveName，`is_visible` 读 `statusItem.visible`（13+），`rect` 读屏幕坐标（`button.window` 为 nil 时返回零 rect）。
- 本次发现的**新症状**：`visible=true` + `rect` 非零，但坐标在屏幕外（位置错乱，疑似 macOS 13+ 在密集销毁重建后布局基点异常）。

## 三、已实施的修复（按时间顺序，均在本分支）

| 提交 | 内容 | 效果 |
|---|---|---|
| c64014f | FundMNFInfo 数据日志改为 FUND01_DEBUG 门控 | 日志噪音治理（已生效） |
| a389487 | 开关切换 hiddenRef 基准 + 总览启动无条件恢复 | 数据竞态修复 |
| 3419fa0 | 总览启动恢复：6×700ms 延迟重试 + killall SystemUIServer | 总览重启恢复 ✅ |
| 9de6a4d | ConfigPort 全局串行化 + 开关防抖 | 数据竞态根治 |
| fb201ed | Tauri 配置镜像乐观同步 + 前端点击日志直达终端 | 数据竞态根治 |
| 609bef1 | updateSettings 真 async + 开关等回调再放开 | 交互层防连点 |
| 455b190 | 可见性自愈推广到全部分组实例；去掉 REMOVED_BY_USER 永久跳过 | 分组自愈（未覆盖本次场景） |
| 1d1c7fd | 保存禁用范围扩到全部分组操作 + 300ms | UI |
| 2c9a5d1 | 启动恢复任务泛化为全部实例 | 覆盖全实例（未解决本次场景） |
| 950d3ad | 可见性判定升级「真正渲染」（visible + rect 非零） | 覆盖 rect=0 场景（未解决） |
| b8284c9 | 启动诊断日志（打印各实例 rect + 屏幕尺寸） | 诊断手段 ✅（定位了 y=-22） |
| 78ba060 | 可见性判定增加**屏幕边界校验**（rect 在主屏内） | 应触发自愈链 → killall（**用户复测仍无效，未验证 killall 是否触发**） |

## 四、当前代码状态

- `menubar.rs` 的可见性判定（`instance_is_visible`）现在是**三道校验**：`statusItem.visible` + `rect` 非零 + **rect 在主屏可视范围内**（78ba060）。
- 自愈链：不可见 → `set_visible(true)` → 无效 → 销毁重建 → 启动恢复任务 6×700ms 重试 → 仍不可见 → `killall SystemUIServer`。
- **关键缺口**：用户反馈 78ba060 后「还是一样」，但**未提供新日志**，无法确认自愈链是否真的走到 `killall SystemUIServer`、killall 后是否恢复。这是下一步要验证的第一件事。

## 五、未解之谜 / 待验证假设

1. **y=-22 从哪来？** 总览 y=1126 正常、分组 y=-22 异常，二者创建顺序/处理路径差异？（总览在 desired 中第一个；分组随后）——是否 macOS 对「同 app 多实例密集销毁重建」的布局基点计算 bug？
2. **killall SystemUIServer 是否有效？**（菜单栏整体重建，理论上强制重排）——78ba060 后未拿到复测日志。
3. **是否与实例数量有关？** 用户早期「只剩 2 个分组来回点也有问题」（那是数据问题已修）；本次场景下若只保留 1~2 个分组重启，是否正常？
4. **插件侧是否有可绕过的位置设置？** 插件 native（multiline_menubar.mm）创建 status item 时未设置显式位置，依赖系统布局；可否在创建后延迟强制 reposition（如重新 `visible` 切换 / `removeStatusItem` + 重建）？
5. **控制中心移除列表残留**：用户之前用旧版本（无 RemovalAllowed）拖出导致全部消失、系统可能记住了 per-app 状态；app 级开关已勾选，但系统内部可能仍有 per-item 记忆（无 per-item 开关可操作）。

## 六、建议的下一步排查（供后续处理）

1. **先拿 78ba060 之后的新日志**：确认是否出现 `killall SystemUIServer 重建菜单栏` 及之后结果；若 killall 生效，问题闭环。
2. 若 killall 无效：
   - 在插件 repo（`lingyired/tauri-plugin-multiline-menubar`）调查 status item 创建/位置逻辑，尝试「创建后延迟重设 visible / 重建」；
   - 尝试对分组实例在创建后显式触发一次布局刷新（如短暂 `visible=false` 再 `true`）；
   - 验证数量相关性：仅保留 2 个分组重启对比。
3. **产品级兜底方案**（若系统行为无法绕过）：放弃「每分组一个 NSStatusItem」的 1:1 方案，改用一个实例（如总览）+ 点击弹出分组切换，从源头消除多实例布局问题。
4. 长期建议在插件层修复（若确认是插件创建时序问题），避免 app 层反复自愈打补丁。

## 七、涉及代码位置

> 改造后：`menubar.rs` 已删除 `instance_is_visible` / `ensure_instance_visible` / `destroy_instance` / `spawn_startup_recovery` / `REMOVED_BY_USER` / `STARTUP_RECOVERY_DONE`；显隐唯一入口是 `sync_instances` 内的 `set_visible`。

- `apps/tauri/src-tauri/src/menubar.rs`：`desired_instances`（`Vec<InstanceSpec>` 全集 + `visible`）、`sync_instances`（create 去重 + set_visible 下发 + 仅删分组）、`apply_menubar_style`、`update_menubar`、`rebuild_menubar`、`ensure_remove_listener`（⌘-拖出=取消勾选，实例保留）
- `apps/tauri/src-tauri/src/lib.rs`：`setup()` 主线程调 `rebuild_menubar`（不再同步回读 `is_visible`，不再触发 churn）
- 插件：`lingyired/tauri-plugin-multiline-menubar`（git 依赖，tag v1.6.0）——参照 `docs/INTEGRATION-NOTES.md` 与 `examples/demo` 的合并模型
- 前端：`packages/ui/src/OptionsApp.tsx`（MenubarSection 开关/订阅 config-change，行为不变）

## 八、回滚参考

若需要回退到「分组显示正常」的稳定状态：问题在重启场景，此前分支早期提交（如 3419fa0 之前）分组显示正常；但数据竞态/开关问题依赖后续提交修复，不建议整体回滚。可单独评估是否保留 455b190 之后的可见性自愈逻辑（它们对运行中场景有益）。
