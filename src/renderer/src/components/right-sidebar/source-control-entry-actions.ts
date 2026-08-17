import type { GitStatusEntry } from '../../../../shared/types'
import { isStageableStatusEntry, isSubmoduleWorktreeOnlyChange } from './discard-all-sequence'

/**
 * Per-row Source Control action eligibility, centralized so the stage/unstage/
 * discard gates stay consistent between the row UI, bulk selection, and tests.
 * A submodule-internal row (`submoduleRoot` set) is read-only from the parent
 * worktree: the parent repo's git can't stage/unstage/discard changes that live
 * in the submodule's own working tree, so those actions are suppressed here.
 */

export function canStageStatusEntry(entry: GitStatusEntry): boolean {
  return isStageableStatusEntry(entry)
}

export function canUnstageStatusEntry(entry: GitStatusEntry): boolean {
  return entry.area === 'staged' && !entry.submoduleRoot
}

export function canDiscardStatusEntry(entry: GitStatusEntry): boolean {
  return (
    entry.conflictStatus !== 'unresolved' &&
    entry.conflictStatus !== 'resolved_locally' &&
    !entry.submoduleRoot &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  )
}

// Why: the bulk stage/unstage flow routes each submoduleRoot group through its own
// submodule context (buildSubmoduleContext), so submodule-internal rows ARE
// eligible here — unlike the single-row gates above, which still target the parent
// worktree. The conflict and worktree-only-submodule guards still apply.
export function isBulkStageableStatusEntry(entry: GitStatusEntry): boolean {
  return (
    (entry.area === 'unstaged' || entry.area === 'untracked') &&
    entry.conflictStatus !== 'unresolved' &&
    !isSubmoduleWorktreeOnlyChange(entry)
  )
}

export function isBulkUnstageableStatusEntry(entry: GitStatusEntry): boolean {
  return entry.area === 'staged'
}
