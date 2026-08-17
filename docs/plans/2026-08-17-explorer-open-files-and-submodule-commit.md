# FileExplorer 打开文件栏 + Source Control 子模块勾选提交 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 right-sidebar 的 FileExplorer 顶部加可拖拽排序+关闭的"打开的文件"栏；让 SourceControl 能勾选子模块内文件并跨 area 分组提交。

**Architecture:** 功能1复用 `EditorSlice.openFiles`，新 store action `reorderOpenFiles` 重排数组，新组件 `OpenEditorsSection` 用 dnd-kit（同 tab-bar）渲染在 FileExplorer 树顶部，关闭走已有 `closeFile`。功能2给子模块真实 entries 行接 checkbox（复用 `useSourceControlSelection`），stage/commit 按 `entry.submoduleRoot` 分组，每组构造子模块 `RuntimeGitContext`（`worktreePath = 父path+子模块路径, worktreeId=null` 走 local 分支）独立调用现有 `stageRuntimeGitPath`/`commitRuntimeGit`。

**Tech Stack:** React + TypeScript, Zustand (`useAppStore`), dnd-kit (`@dnd-kit/sortable` + `@dnd-kit/core`), Vitest, Tailwind tokens from `src/renderer/src/assets/main.css`。

## Global Constraints

- 设计 spec: `docs/specs/2026-08-17-explorer-open-files-and-submodule-commit-design.md`
- 颜色/间距用 `main.css` token，不发明新色值（AGENTS.md 设计系统）
- 不动 worktree 父子层级、不新增独立 source-control 面板、不做子模块嵌套递归（spec 范围外）
- 提交目标分支: `v1.4.183-inner`（当前分支）
- 测试: Vitest，配置 `config/vitest.config.ts`，跑 `node_modules/.bin/vitest run --config config/vitest.config.ts <path>`

## File Structure

**功能1:**
- Create: `src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx` — 打开文件栏组件（渲染+拖拽+关闭）
- Create: `src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx` — 测试
- Modify: `src/renderer/src/store/slices/editor.ts` — 加 `reorderOpenFiles` action + EditorSlice 类型
- Modify: `src/renderer/src/store/slices/editor.test.ts` — action 测试
- Modify: `src/renderer/src/components/right-sidebar/FileExplorer.tsx:662-690` — JSX 顶部插入 `<OpenEditorsSection/>`

**功能2:**
- Modify: `src/renderer/src/components/right-sidebar/SourceControl.tsx` — 子模块行 checkbox + stage/commit 分组（多处）
- Create: `src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.ts` — 子模块 context 构造 + 分组纯函数
- Create: `src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.test.ts` — 纯函数测试

---

### Task 1: `reorderOpenFiles` store action

**Files:**
- Modify: `src/renderer/src/store/slices/editor.ts`（`closeFile` 之后 ~2190 附近，EditorSlice 类型 ~528）
- Test: `src/renderer/src/store/slices/editor.test.ts`

**Interfaces:**
- Produces: `reorderOpenFiles: (worktreeId: string, fromIndex: number, toIndex: number) => void` — 仅重排该 worktreeId 的 openFiles 子序列，跨 worktree 索引无效（no-op）

- [ ] **Step 1: Write the failing test**

在 `editor.test.ts` 末尾追加：

```ts
import { useAppStore } from '../index'

describe('reorderOpenFiles', () => {
  beforeEach(() => {
    useAppStore.setState({
      openFiles: [
        { id: 'a', filePath: '/w/a', relativePath: 'a', worktreeId: 'w', language: 'text', isDirty: false },
        { id: 'b', filePath: '/w/b', relativePath: 'b', worktreeId: 'w', language: 'text', isDirty: false },
        { id: 'c', filePath: '/w/c', relativePath: 'c', worktreeId: 'w', language: 'text', isDirty: false }
      ]
    })
  })

  it('reorders within a worktree', () => {
    useAppStore.getState().reorderOpenFiles('w', 0, 2)
    const ids = useAppStore.getState().openFiles.map((f) => f.id)
    expect(ids).toEqual(['b', 'c', 'a'])
  })

  it('is a no-op when indices are out of range', () => {
    useAppStore.getState().reorderOpenFiles('w', 0, 9)
    expect(useAppStore.getState().openFiles.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores other worktrees', () => {
    useAppStore.setState((s) => ({ openFiles: [...s.openFiles, { id: 'z', filePath: '/x/z', relativePath: 'z', worktreeId: 'other', language: 'text', isDirty: false }] }))
    useAppStore.getState().reorderOpenFiles('w', 0, 1)
    const byWorktree = useAppStore.getState().openFiles.filter((f) => f.worktreeId === 'other').map((f) => f.id)
    expect(byWorktree).toEqual(['z'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/store/slices/editor.test.ts -t reorderOpenFiles`
Expected: FAIL with `reorderOpenFiles is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `editor.ts` 的 EditorSlice 类型（`closeFile` 行 ~528）加：

```ts
  reorderOpenFiles: (worktreeId: string, fromIndex: number, toIndex: number) => void
```

在 `closeFile` 实现之后（~2190 附近）加：

```ts
  reorderOpenFiles: (worktreeId, fromIndex, toIndex) => {
    if (fromIndex === toIndex) {
      return
    }
    set((s) => {
      // Why: only reorder the contiguous subsequence belonging to worktreeId; other worktrees' files stay put.
      const indices = s.openFiles
        .map((f, i) => ({ f, i }))
        .filter((x) => x.f.worktreeId === worktreeId)
        .map((x) => x.i)
      if (fromIndex < 0 || fromIndex >= indices.length || toIndex < 0 || toIndex >= indices.length) {
        return s
      }
      const fromGlobal = indices[fromIndex]
      const toGlobal = indices[toIndex]
      const next = [...s.openFiles]
      const [moved] = next.splice(fromGlobal, 1)
      next.splice(toGlobal, 0, moved)
      return { openFiles: next }
    })
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/store/slices/editor.test.ts -t reorderOpenFiles`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/slices/editor.ts src/renderer/src/store/slices/editor.test.ts
git commit -m "feat(editor): add reorderOpenFiles store action for the open-files bar"
```

---

### Task 2: `OpenEditorsSection` 组件（渲染 + 关闭）

**Files:**
- Create: `src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx`
- Create: `src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx`
- Modify: `src/renderer/src/components/right-sidebar/FileExplorer.tsx:662`（return 的 `<FileExplorerToolbar/>` 之后插 `<OpenEditorsSection/>`）

**Interfaces:**
- Consumes: `useAppStore` `openFiles`、`closeFile`、`activeWorktreeId`、`setActiveFile`（已有）
- Produces: `<OpenEditorsSection />` props 无，内部订阅 store；空态返回 `null`

- [ ] **Step 1: Write the failing test**

`OpenEditorsSection.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useAppStore } from '@/store'
import { OpenEditorsSection } from './OpenEditorsSection'

describe('OpenEditorsSection', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorktreeId: 'w',
      openFiles: [],
      activeFileIdByWorktree: {},
      closeFile: vi.fn(),
      setActiveFile: vi.fn()
    } as any)
  })

  it('renders nothing when no open files for the active worktree', () => {
    const { container } = render(<OpenEditorsSection />)
    expect(container.firstChild).toBeNull()
  })

  it('lists open files and closes on × click', () => {
    useAppStore.setState({
      openFiles: [
        { id: 'a', filePath: '/w/a.ts', relativePath: 'a.ts', worktreeId: 'w', language: 'typescript', isDirty: false },
        { id: 'b', filePath: '/w/b.ts', relativePath: 'b.ts', worktreeId: 'w', language: 'typescript', isDirty: true }
      ]
    } as any)
    render(<OpenEditorsSection />)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0])
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`OpenEditorsSection.tsx`（拖拽在 Task 3 加，本任务先静态渲染 + 关闭）:

```tsx
import { useAppStore } from '@/store'
import { X } from 'lucide-react'

export function OpenEditorsSection(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)

  const files = openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  if (files.length === 0) {
    return null
  }
  const activeId = activeWorktreeId ? activeFileIdByWorktree?.[activeWorktreeId] : null

  return (
    <div className="border-b border-border px-1 py-1">
      <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Open Editors
      </div>
      {files.map((f) => (
        <div
          key={f.id}
          role="row"
          onClick={() => setActiveFile(f.id)}
          className={
            'flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent ' +
            (f.id === activeId ? 'bg-accent' : '')
          }
        >
          <span className="min-w-0 flex-1 truncate">{f.relativePath}</span>
          {f.isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
          <button
            type="button"
            aria-label="close"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              closeFile(f.id)
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
```

`FileExplorer.tsx` 在 `<FileExplorerToolbar ... />` 之后、`<FileExplorerQueryStrip>` 之前插入：

```tsx
        <OpenEditorsSection />
```

并加 import: `import { OpenEditorsSection } from './OpenEditorsSection'`

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx src/renderer/src/components/right-sidebar/FileExplorer.tsx
git commit -m "feat(explorer): add OpenEditorsSection (render + close) atop FileExplorer"
```

---

### Task 3: 拖拽排序接入（dnd-kit）

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx` — 包 DndContext + SortableContext，落点调 `reorderOpenFiles`
- Modify: `src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx` — 拖拽测试

**Interfaces:**
- Consumes: `reorderOpenFiles`（Task 1）、`@dnd-kit/core` `DndContext`、`@dnd-kit/sortable` `SortableContext`/`useSortable`/`arrayMove`（tab-bar 已用）

参考范式: `src/renderer/src/components/tab-bar/tab-bar-surface.tsx`（`SortableContext` + `DndContext` 的 onDragEnd 用 `arrayMove` 重排）。

- [ ] **Step 1: Write the failing test**

追加到 `OpenEditorsSection.test.tsx`:

```tsx
import { DndContext } from '@dnd-kit/core'

it('reorders on drag end via reorderOpenFiles', () => {
  useAppStore.setState({
    openFiles: [
      { id: 'a', filePath: '/w/a', relativePath: 'a', worktreeId: 'w', language: 'text', isDirty: false },
      { id: 'b', filePath: '/w/b', relativePath: 'b', worktreeId: 'w', language: 'text', isDirty: false }
    ],
    reorderOpenFiles: vi.fn()
  } as any)
  const { container } = render(<OpenEditorsSection />)
  // Why: the section wraps rows in a DndContext; fire its onDragEnd by querying the sortable item's drag handle.
  const onDragEnd = (container.querySelector('[data-dnd-context]') as any)?._reactProps?.onDragEnd
  expect(onDragEnd).toBeDefined()
  onDragEnd?.({ active: { id: 'a' }, over: { id: 'b' } })
  expect(useAppStore.getState().reorderOpenFiles).toHaveBeenCalledWith('w', 0, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx -t "reorders on drag end"`
Expected: FAIL — `_reactProps` undefined（未接 dnd）

- [ ] **Step 3: Write minimal implementation**

`OpenEditorsSection.tsx` 改造：把行列表包进 DndContext + SortableContext，行用 `useSortable`。关键骨架:

```tsx
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove } from '@dnd-kit/sortable'

// inside component, after computing `files`:
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
const ids = files.map((f) => f.id)
const handleDragEnd = (e: DragEndEvent) => {
  const { active, over } = e
  if (!over || active.id === over.id) return
  const from = ids.indexOf(String(active.id))
  const to = ids.indexOf(String(over.id))
  if (from < 0 || to < 0) return
  reorderOpenFiles(activeWorktreeId!, from, to)
}
return (
  <div className="border-b border-border px-1 py-1" data-dnd-context>
    <div className="...header...">Open Editors</div>
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={ids}>
        {files.map((f) => <SortableOpenFileRow key={f.id} file={f} active={f.id === activeId} onClose={() => closeFile(f.id)} onSelect={() => setActiveFile(f.id)} />)}
      </SortableContext>
    </DndContext>
  </div>
)
```

`SortableOpenFileRow` 用 `useSortable({ id: file.id })`，把 `attributes/listeners` spread 到行根 + 关闭按钮 `onPointerDown` stopPropagation（避免点 × 触发拖）。订阅 `useAppStore((s) => s.reorderOpenFiles)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/OpenEditorsSection.tsx src/renderer/src/components/right-sidebar/OpenEditorsSection.test.tsx
git commit -m "feat(explorer): drag-to-reorder OpenEditorsSection via dnd-kit"
```

---

### Task 4: 子模块 stage/commit 分组纯函数

**Files:**
- Create: `src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.ts`
- Create: `src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.test.ts`

**Interfaces:**
- Produces:
  - `groupSelectedBySubmoduleRoot(entries: ReadonlyArray<FlatEntry>): Map<string | null, string[]>` — key=null 为父仓组，key=子模块相对路径为子模块组；value=该组选定条目的 `entry.path`（子模块组内 path 是相对子模块根的路径——见 Step 3 Why）
  - `buildSubmoduleContext(parent: RuntimeGitContext, submoduleRoot: string): RuntimeGitContext` — `{ ...parent, worktreePath: join(parent.worktreePath, submoduleRoot), worktreeId: null }`（local 分支靠 worktreePath 作 cwd）
- Consumes: `RuntimeGitContext`（`src/renderer/src/runtime/runtime-git-client.ts:70`）、`FlatEntry`（`useSourceControlSelection.ts`）、`path.join`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { groupSelectedBySubmoduleRoot, buildSubmoduleContext } from './source-control-submodule-stage-commit'
import type { FlatEntry } from './useSourceControlSelection'

const fe = (path: string, submoduleRoot?: string): FlatEntry => ({
  key: `${submoduleRoot ?? ''}::${path}`,
  area: 'unstaged',
  entry: { path, submoduleRoot, area: 'unstaged', status: 'M', added: 0, removed: 0 } as any
})

describe('groupSelectedBySubmoduleRoot', () => {
  it('splits parent and submodule groups', () => {
    const groups = groupSelectedBySubmoduleRoot([fe('root.txt'), fe('sub/a.ts', 'sub'), fe('sub/b.ts', 'sub')])
    expect([...groups.keys()].sort()).toEqual([null, 'sub'])
    expect(groups.get(null)).toEqual(['root.txt'])
    expect(groups.get('sub')).toEqual(['a.ts', 'b.ts'])
  })
})

describe('buildSubmoduleContext', () => {
  it('joins parent path with submodule root and nulls worktreeId for the local branch', () => {
    const ctx = buildSubmoduleContext({ settings: null, worktreeId: 'w', worktreePath: '/repo', connectionId: 'c' }, 'vendor/sub')
    expect(ctx.worktreePath.replace(/\\/g, '/')).toBe('/repo/vendor/sub')
    expect(ctx.worktreeId).toBeNull()
    expect(ctx.connectionId).toBe('c')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --config config/vitest.config.ts src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
import { join } from 'node:path'
import type { RuntimeGitContext } from '../../runtime/runtime-git-client'
import type { FlatEntry } from './useSourceControlSelection'

// Why: parent git cannot stage/commit inside a submodule's nested worktree dirtiness,
// so each submoduleRoot forms its own group whose paths are relative to that submodule
// root (the GitStatusEntry.path inside an expanded submodule is already submodule-relative).
export function groupSelectedBySubmoduleRoot(
  entries: ReadonlyArray<FlatEntry>
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>()
  for (const e of entries) {
    const root: string | null = e.entry.submoduleRoot ?? null
    const list = groups.get(root) ?? []
    list.push(e.entry.path)
    groups.set(root, list)
  }
  return groups
}

// Why: commitRuntimeGit/stageRuntimeGitPath run `git -C <worktreePath>` for local targets;
// pointing worktreePath at the submodule dir + worktreeId=null forces the local branch,
// so the op runs inside the submodule.
export function buildSubmoduleContext(
  parent: RuntimeGitContext,
  submoduleRoot: string
): RuntimeGitContext {
  return {
    ...parent,
    worktreePath: join(parent.worktreePath, submoduleRoot),
    worktreeId: null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.ts src/renderer/src/components/right-sidebar/source-control-submodule-stage-commit.test.ts
git commit -m "feat(source-control): submodule-root grouping + context builder"
```

---

### Task 5: 子模块行 checkbox 勾选接入

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/SourceControl.tsx` — 子模块真实 entries 行渲染处（~6175 `depth={entry.submoduleRoot ? 1 : 0}` 附近的行组件）加 checkbox，调现有 `toggleSelected`/`selectedKeys`（来自 `useSourceControlSelection`）

**Interfaces:**
- Consumes: `useSourceControlSelection` 的 `selectedKeys: Set<string>` + `toggleSelected(key)`；行已有 `entry.key`（`area::path`）；子模块 placeholder 行（`type === 'submodule-placeholder'`）不接

- [ ] **Step 1: 定位行渲染组件**

Run: `grep -n "submoduleRoot ? 1 : 0\|SourceControlRow\|FileStatusRow\|toggleSelected\|selectedKeys.has" src/renderer/src/components/right-sidebar/SourceControl.tsx | head`
读该行组件，确认 props（`entry`、`selected`、`onToggle`）。

- [ ] **Step 2: Write the failing test（断言子模块行 checkbox 存在 + toggle 生效）**

参考现有 `SourceControl.test` 范式（`grep -l "SourceControl" src/renderer/src/components/right-sidebar/*.test.tsx`）。在现有或新建 SourceControl 子模块测试里断言：展开子模块、其真实 entries 行含 `role="checkbox"`，点击调 `toggleSelected`。

- [ ] **Step 3: Write minimal implementation**

在子模块真实 entries 行（非 placeholder）渲染 `<button role="checkbox" aria-checked={selected} onClick={() => toggleSelected(entry.key)} />`。条件：`entry.type !== 'submodule-placeholder'`。父仓行已有选择逻辑的，复用同一 `onToggle`。placeholder 行不渲染 checkbox。

- [ ] **Step 4: Run tests + 手测（展开子仓 → 子模块内文件行出现 checkbox 可勾选，勾选进入 selectedKeys）**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/SourceControl.tsx
git commit -m "feat(source-control): checkbox on expanded submodule entries"
```

---

### Task 6: stage 按 submoduleRoot 分组

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/SourceControl.tsx` — `bulkStagePaths`（~4620 附近，`selectedEntries.filter(area==='unstaged'||'untracked')`）改为按 `groupSelectedBySubmoduleRoot` 分组；`handleBulkStage`（~4628）对每组用对应 context 调 `bulkStageRuntimeGitPaths`（父仓组用原 context，子模块组用 `buildSubmoduleContext`）
- 去掉 `bulkUnstagePaths` 的 `!entry.entry.submoduleRoot` 过滤（~4626），改为分组调 `bulkUnstageRuntimeGitPaths`（子模块组用子模块 context）

**Interfaces:**
- Consumes: `groupSelectedBySubmoduleRoot`、`buildSubmoduleContext`（Task 4）、`bulkStageRuntimeGitPaths`/`bulkUnstageRuntimeGitPaths`（runtime-git-client）、现有 `gitContext`（SourceControl 内已构造的父 context）

- [ ] **Step 1: 定位 `bulkStagePaths`/`bulkUnstagePaths`/`handleBulkStage`/`handleBulkUnstage`**

Run: `grep -n "bulkStagePaths\|bulkUnstagePaths\|handleBulkStage\|handleBulkUnstage\|gitContext" src/renderer/src/components/right-sidebar/SourceControl.tsx | head`

- [ ] **Step 2: Write the failing test（纯逻辑层）**

断言 `handleBulkStage` 在选定含子模块路径时对父仓调一次 `bulkStageRuntimeGitPaths(parentCtx, ['root.txt'])`、对子模块调一次 `bulkStageRuntimeGitPaths(subCtx, ['a.ts','b.ts'])`。mock `bulkStageRuntimeGitPaths`。

- [ ] **Step 3: Write minimal implementation**

```ts
// in handleBulkStage (replace single bulkStageRuntimeGitPaths call):
const stagedEntries = selectedEntries.filter((e) => e.area === 'unstaged' || e.area === 'untracked')
const groups = groupSelectedBySubmoduleRoot(stagedEntries)
for (const [root, paths] of groups) {
  const ctx = root ? buildSubmoduleContext(gitContext, root) : gitContext
  await bulkStageRuntimeGitPaths(ctx, paths)
}
```

`bulkUnstagePaths` 同理分组（去掉 `!submoduleRoot` 过滤）。

- [ ] **Step 4: Run tests + 手测（子仓内勾选文件 → Stage Selected → 子模块内 staged）**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/SourceControl.tsx
git commit -m "feat(source-control): stage selected across submodule roots"
```

---

### Task 7: commit 按 submoduleRoot 分组提交

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/SourceControl.tsx` — commit 调用（~2122 `commitRuntimeGit(`）改为按 `groupSelectedBySubmoduleRoot(stagedEntries)` 分组，每组用对应 context 调 `commitRuntimeGit`；失败汇总进现有 `summarizeCommitFailure`（~235 import）
- Modify: `getCreatePrIntentStagePaths` 调用（~3892）——保持父仓逻辑不变，子模块路径由 Task 6 已 stage，commit 时按组各自提交已 stage 内容

**Interfaces:**
- Consumes: `groupSelectedBySubmoduleRoot`、`buildSubmoduleContext`、`commitRuntimeGit`、`summarizeCommitFailure`、staged `selectedEntries`

- [ ] **Step 1: 定位 commit handler + staged 收集**

Run: `grep -n "commitRuntimeGit(\|handleCommit\|const commitResult\|summarizeCommitFailure" src/renderer/src/components/right-sidebar/SourceControl.tsx | head`

- [ ] **Step 2: Write the failing test**

断言：选定 staged 含父仓 + 子模块文件时，`commitRuntimeGit` 被调用两次（parentCtx 一次、subCtx 一次），某子模块失败返回 `success:false` 不阻塞父仓提交，失败信息进汇总。

- [ ] **Step 3: Write minimal implementation**

```ts
// replace the single commitRuntimeGit call in the commit handler:
const staged = selectedEntries.filter((e) => e.area === 'staged')
const groups = groupSelectedBySubmoduleRoot(staged)
const failures: string[] = []
for (const [root] of groups) {
  const ctx = root ? buildSubmoduleContext(gitContext, root) : gitContext
  const result = await commitRuntimeGit(ctx, message)
  if (!result.success && result.error) {
    failures.push(summarizeCommitFailure(result.error, root ?? undefined))
  }
}
// surface `failures` via existing failure-summary UI; parent success not blocked by submodule failure
```

- [ ] **Step 4: Run tests + 手测（勾选父仓+子模块文件 → Commit → 各 area 各自提交，失败不互相阻塞）**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/SourceControl.tsx
git commit -m "feat(source-control): commit selected across submodule roots"
```

---

## Self-Review

- **Spec 覆盖**: 功能1（栏/拖拽/关闭→T1-T3，集成→T2 Step3）✓；功能2（勾选→T5、stage→T6、commit→T7、分组纯函数→T4）✓。测试要点 spec 每条都有对应任务。
- **Placeholder**: 无 TBD；T5/T6/T7 的"定位行"步骤给了 grep 命令而非空泛描述；组件测试引用现有范式而非"写测试"空话。
- **类型一致**: `reorderOpenFiles(worktreeId, from, to)`、`groupSelectedBySubmoduleRoot`、`buildSubmoduleContext` 跨任务签名一致；`FlatEntry`/`RuntimeGitContext` 引用真实类型。

## Execution Handoff

Plan complete and saved to `docs/plans/2026-08-17-explorer-open-files-and-submodule-commit.md`. 两种执行方式：

1. **Subagent-Driven（推荐）** — 每个 Task 派新 subagent，任务间我 review，迭代快
2. **Inline Execution** — 在本会话按 executing-plans 批量执行，带 checkpoint review

选哪个？
