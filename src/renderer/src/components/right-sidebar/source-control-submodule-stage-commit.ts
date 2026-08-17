import { join } from 'node:path'
import type { RuntimeGitContext } from '../../runtime/runtime-git-client'
import type { FlatEntry } from './useSourceControlSelection'

// Why: parent git cannot stage/commit inside a submodule's nested worktree dirtiness,
// so each submoduleRoot forms its own group whose paths are relative to that submodule
// root (buildSubmoduleChildEntry prefixes child paths with `${root}/`, stripped here).
export function groupSelectedBySubmoduleRoot(
  entries: readonly FlatEntry[]
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>()
  for (const e of entries) {
    const root: string | null = e.entry.submoduleRoot ?? null
    const list = groups.get(root) ?? []
    // Why: child paths are prefixed with `${root}/` (buildSubmoduleChildEntry);
    // git -C <parent/root> needs paths relative to the submodule root.
    const rel =
      root && e.entry.path.startsWith(`${root}/`) ? e.entry.path.slice(root.length + 1) : e.entry.path
    list.push(rel)
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

export type BulkStageCall = { context: RuntimeGitContext; paths: string[] }

// Why: the parent repo's git can't stage paths inside a submodule, so bulk stage
// splits the selection by submoduleRoot and pairs each group with the context that
// can actually act on it (parent context for null-root entries, submodule context
// for the rest). The caller still filters to stageable entries first.
export function planBulkStageContexts(
  selectedEntries: readonly FlatEntry[],
  parent: RuntimeGitContext
): BulkStageCall[] {
  const groups = groupSelectedBySubmoduleRoot(selectedEntries)
  const plan: BulkStageCall[] = []
  for (const [root, paths] of groups) {
    if (paths.length === 0) {
      continue
    }
    plan.push({ context: root ? buildSubmoduleContext(parent, root) : parent, paths })
  }
  return plan
}
