import { joinPath } from '@/lib/path'
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
    worktreePath: joinPath(parent.worktreePath, submoduleRoot),
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

export type CommitResult = { success: boolean; error?: string }
export type CommitFn = (context: RuntimeGitContext, message: string) => Promise<CommitResult>
export type CommitGroupFailure = { root: string | null; error: string }

// Why: like staging, a commit must run per submoduleRoot — parent git can't commit
// inside a submodule. Each present root forms its own group; empty groups are skipped
// so a submodule-only selection doesn't spuriously fail an empty parent commit. When
// no group has staged paths (no selection, or all were unstaged), fall back to a single
// parent commit so the primary "type message + Commit" path still runs. One group's
// failure must not abort the others, so failures are collected, not thrown.
export async function commitSelectedAcrossSubmoduleRoots(
  selectedEntries: readonly FlatEntry[],
  parent: RuntimeGitContext,
  commit: CommitFn,
  message: string
): Promise<{ failures: CommitGroupFailure[]; success: boolean }> {
  const staged = selectedEntries.filter((e) => e.area === 'staged')
  const groups = groupSelectedBySubmoduleRoot(staged)
  const failures: CommitGroupFailure[] = []
  let committedAny = false
  for (const [root, paths] of groups) {
    if (paths.length === 0) continue
    committedAny = true
    const ctx = root ? buildSubmoduleContext(parent, root) : parent
    const result = await commit(ctx, message)
    if (!result.success) {
      failures.push({ root, error: result.error ?? 'Commit failed' })
    }
  }
  if (!committedAny) {
    const result = await commit(parent, message)
    if (!result.success) {
      failures.push({ root: null, error: result.error ?? 'Commit failed' })
    }
  }
  return { failures, success: failures.length === 0 }
}
