import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { FileSearchRange, SearchResult } from '../../../../shared/types'
import {
  isDocumentInCodeIntelligenceScope,
  memberWorkspaceRelativePath
} from '@/lib/language-server/code-intelligence-scope-membership'

/**
 * #77 range-switch model: the ◆ Scope side searches the union of all language
 * groups' member dirs. v1 joins local enumerable members only — SSH scopes and
 * out-of-tree members never qualify.
 */
export function getFileSearchRangeScopes(
  scopes: readonly CodeIntelligenceScope[]
): CodeIntelligenceScope[] {
  return scopes.filter((scope) => parseExecutionHostId(scope.executionHostId)?.kind !== 'ssh')
}

export function hasFileSearchScopeRangeMembers(scopes: readonly CodeIntelligenceScope[]): boolean {
  return getFileSearchRangeScopes(scopes).some((scope) =>
    scope.members.some((member) => memberWorkspaceRelativePath(scope, member) !== null)
  )
}

export function isRelativePathInFileSearchScopeRange(
  scopes: readonly CodeIntelligenceScope[],
  relativePath: string
): boolean {
  return getFileSearchRangeScopes(scopes).some((scope) =>
    isDocumentInCodeIntelligenceScope(scope, relativePath)
  )
}

export function filterRelativePathsByFileSearchScopeRange(
  relativePaths: readonly string[],
  scopes: readonly CodeIntelligenceScope[]
): string[] {
  return relativePaths.filter((relativePath) =>
    isRelativePathInFileSearchScopeRange(scopes, relativePath)
  )
}

/**
 * Contents-mode range restriction (#75: pre-search selector, not a post-filter
 * UX). ponytail: applies after the runtime scan, so `truncated` can over-report
 * when the pre-range result set hit the cap; push member globs into the runtime
 * include pattern if scan cost ever matters.
 */
export function filterSearchResultsByFileSearchScopeRange(
  results: SearchResult,
  scopes: readonly CodeIntelligenceScope[]
): SearchResult {
  const files = results.files.filter((file) =>
    isRelativePathInFileSearchScopeRange(scopes, file.relativePath)
  )
  if (files.length === results.files.length) {
    return results
  }
  const totalMatches = files.reduce((count, file) => count + file.matches.length, 0)
  return { ...results, files, totalMatches }
}

/**
 * Worktree-range ◆ marker predicate: markers only distinguish in-scope hits
 * while searching the whole tree — ◆ Scope results are in range by
 * construction, so the predicate is undefined there.
 */
export function createWorktreeRangeMarkerPredicate(
  effectiveRange: FileSearchRange,
  scopeRangeUnavailable: boolean,
  scopes: readonly CodeIntelligenceScope[]
): ((relativePath: string) => boolean) | undefined {
  return effectiveRange === 'worktree' && !scopeRangeUnavailable
    ? (relativePath: string) => isRelativePathInFileSearchScopeRange(scopes, relativePath)
    : undefined
}
