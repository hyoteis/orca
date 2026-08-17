# FileExplorer 打开文件栏 + Source Control 子模块勾选提交

- 日期: 2026-08-17
- 范围: right-sidebar 的 `FileExplorer` 与 `SourceControl` 面板增强
- 目标: ① 资源管理器顶部加"打开的文件"栏（拖拽排序 + 关闭）；② 源代码控制里能勾选子模块内文件提交

## 现状（探索结论）

- `EditorSlice.openFiles: OpenFile[]` 已存在，按 `worktreeId` 分组，含 `isPreview` / `activeFileIdByWorktree`。`closeFile` 已存在。
- `FileExplorer.tsx` 仅把 `openFiles` 用于 auto-reveal 与删除快捷键；**顶部"打开的文件"栏不存在**。
- `SourceControl.tsx` 已有 submodule 展开（`expandedSubmoduleKeys` / `submoduleStatusByKey` / `toggleSubmodule`，带 loading/empty/error placeholder）、stage/unstage（`stageRuntimeGitPath` / `bulkStageRuntimeGitPaths`，含"Stage inside submodule"分支）、commit（`commitRuntimeGit`）、选择（`useSourceControlSelection`）。
- 缺口：子模块内**已加载真实 entries** 行未接入勾选；commit 路径收集排除子模块——`line 4626` 的 `!entry.submoduleRoot` 过滤、`line 3892` 的 `getCreatePrIntentStagePaths` 只取父仓 unstaged/untracked。

## 功能1: FileExplorer 顶部"打开的文件"栏

### 数据

- 复用 `openFiles`，范围 = 当前 `activeWorktreeId` 的条目。
- 新增 store action `reorderOpenFiles(worktreeId, fromIndex, toIndex)`：在 `EditorSlice` 内重排 `openFiles` 数组中该 worktree 的子序列。持久化沿用 `openFiles` 现有持久策略。
- 关闭走已有 `closeFile(fileId)`；若关闭的是 active 文件，由 `closeFile` 既有逻辑切到下一个。

### 组件

- 新文件 `src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx`。
- 渲染于 `FileExplorer` 树顶部，默认展开，可折叠。空态（当前 worktree 无打开文件）整栏隐藏。
- 每行: 文件名（主） + 相对路径（副） + 关闭 × 按钮。

### 拖拽

- 复用 `tab-bar/SortableTab` 的 dnd 模式（确认实际库后落地，HTML5 drag 或 dnd-kit 二选一，跟随现有写法）。
- 落点调 `reorderOpenFiles`。
- drag source 与文件树的 `handleMoveDrop`（移动磁盘文件）严格隔离——两套 source 互不串，避免把"打开文件"拖成"移动文件"。

### 数据流

```
openFiles 变 → OpenEditorsSection 重渲染
拖拽 → reorderOpenFiles → openFiles 更新
× → closeFile → 从数组移除（active 切换由 closeFile 处理）
```

## 功能2: Source Control 子模块内文件勾选 + 选中提交

### 勾选接入

- `useSourceControlSelection` 的 `selectedPaths` / toggle 复用，key 用现有 `area::path`（跨 area 天然不冲突）。
- 子模块**已加载真实 entries**行（`SubmoduleSectionTreeNode`，非 placeholder）渲染 checkbox 并接 toggle。
- placeholder 行（loading/empty/error/truncated）不可选、不渲染 checkbox。

### stage 收集

- `bulkStageRuntimeGitPaths` 收集时纳入子模块 area 的选定路径。
- 单文件 stage 走已有 `stageRuntimeGitPath`（"Stage inside submodule" 分支已存在，尊重父仓不能直接 stage 子模块内文件）。

### commit 收集（核心修复）

- 去掉 `SourceControl.tsx:4626` 的 `!entry.entry.submoduleRoot` 排除，staged 收集纳入子模块。
- 扩展 `getCreatePrIntentStagePaths`（`line 3892`）按 `area` 分组：父仓 area 一组，每个有选定文件的子模块 area 各一组。
- 提交时按 area 分组，每个子模块 area 独立调 `commitRuntimeGit`（父仓一次 + 每个有选定文件的子模块各一次）。

### 错误处理

- 某 area commit 失败不阻塞其他 area；失败汇总进现有 `commit-failure-summary`（`summarizeCommitFailure`）。
- placeholder 处于 error 状态时该子模块不可选、不可提交，UI 提示重试。

## 测试要点

### 功能1

- 拖拽改顺序且 store 持久化
- 关闭 active 文件正确切到下一个
- 空态隐藏整栏
- 与文件树 drag source 不串（打开文件拖拽不触发磁盘移动）

### 功能2

- 子模块真实 entries 行 checkbox toggle 生效
- placeholder 行不可选
- 跨 area 多选按 area 分组提交（父仓 + 多子模块）
- 单子模块 commit 失败不阻塞父仓与其他子模块
- 失败汇总正确

## 范围外（YAGNI）

- 不动 worktree 父子层级显示（已有）。
- 不新增独立"源代码控制"面板——在现有 SourceControl 内修。
- 不做打开文件的 diff 预览（编辑器已有）。
- 不做子模块嵌套递归（子模块的子模块）——按现有 `submoduleStatusByKey` 一层处理。
