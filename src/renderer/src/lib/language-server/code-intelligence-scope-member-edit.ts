import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceScopeId,
  normalizeScopeMemberPath
} from '../../../../shared/code-intelligence-scope'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useAppStore } from '@/store'
import { isDocumentInCodeIntelligenceScope } from './code-intelligence-scope-membership'

export function findCodeIntelligenceScopeForWorkspace(args: {
  settings: GlobalSettings | null | undefined
  repoId: string
  isFolder: boolean
  executionHostId: ExecutionHostId
  language: CodeIntelligenceLanguage
}): CodeIntelligenceScope | null {
  const id = getCodeIntelligenceScopeId({
    executionHostId: args.executionHostId,
    workspaceKey: args.isFolder ? `folder:${args.repoId}` : `worktree:${args.repoId}`,
    language: args.language
  })
  return (
    (args.settings?.codeIntelligenceScopes ?? []).find(
      (scope) => scope.id === id && scope.enabled
    ) ?? null
  )
}

/** Directory-equivalence key, matching normalizeCodeIntelligenceScope's dedup rule. */
function memberKey(scope: CodeIntelligenceScope, path: string): string {
  return normalizeRuntimePathForComparison(
    isRuntimePathAbsolute(path) ? path : resolveRuntimePath(scope.workspaceRoot, path)
  )
}

/** Appends paths as members, skipping ones a member already governs (exact or containing). */
export function addCodeIntelligenceMembers(
  scope: CodeIntelligenceScope,
  paths: readonly string[]
): CodeIntelligenceScope {
  let next = scope
  for (const input of paths) {
    const path = normalizeScopeMemberPath(input)
    const governed =
      (!isRuntimePathAbsolute(path) && isDocumentInCodeIntelligenceScope(next, path)) ||
      next.members.some((member) => memberKey(next, member.path) === memberKey(next, path))
    if (governed) {
      continue
    }
    next = { ...next, members: [...next.members, { path, visibleResults: true }] }
  }
  return next
}

/** Removes exact member matches; refuses (null) when nothing would remain. */
export function removeCodeIntelligenceMembers(
  scope: CodeIntelligenceScope,
  paths: readonly string[]
): CodeIntelligenceScope | null {
  const removable = new Set(paths.map(normalizeScopeMemberPath))
  const members = scope.members.filter((member) => !removable.has(member.path))
  if (members.length === scope.members.length) {
    return scope
  }
  return members.length === 0 ? null : { ...scope, members }
}

export function setCodeIntelligenceMemberVisibility(
  scope: CodeIntelligenceScope,
  memberPath: string,
  visibleResults: boolean
): CodeIntelligenceScope {
  const targets = scope.members.filter(
    (member) => member.path === memberPath && member.visibleResults !== visibleResults
  )
  if (targets.length === 0) {
    return scope
  }
  return {
    ...scope,
    members: scope.members.map((member) =>
      member.path === memberPath ? { ...member, visibleResults } : member
    )
  }
}

/** Persists an edited scope so every surface re-renders from the one settings source. */
export async function writeCodeIntelligenceScopeEdit(
  next: CodeIntelligenceScope
): Promise<boolean> {
  try {
    await window.api.codeIntelligence.upsertScope(next)
    await useAppStore.getState().fetchSettings()
    return true
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'settings.codeIntelligence.changeFailed',
          'Could not update code intelligence folders'
        )
      )
    )
    return false
  }
}
