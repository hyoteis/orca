import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import { isCodeIntelligenceConsentStale } from '../../../../shared/code-intelligence-scope'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import { joinPath } from '../../lib/path'

export type CodePanelMemberRow = {
  path: string
  /** Browsable host directory the member resolves to (absolute form). */
  directory: string
  languages: CodeIntelligenceLanguage[]
  /** True when any owning scope lacks (fresh) consent — member contents stay hidden. */
  browseBlocked: boolean
}

function scopeIsConsented(scope: CodeIntelligenceScope): boolean {
  return scope.consent !== undefined && !isCodeIntelligenceConsentStale(scope)
}

export function buildCodePanelMemberRows(
  scopes: readonly CodeIntelligenceScope[]
): CodePanelMemberRow[] {
  const byPath = new Map<string, CodePanelMemberRow>()
  for (const scope of scopes) {
    for (const member of scope.members) {
      const row = byPath.get(member.path) ?? {
        path: member.path,
        directory: resolveCodePanelMemberDirectory(scope.workspaceRoot, member.path),
        languages: [],
        browseBlocked: false
      }
      if (!row.languages.includes(scope.language)) {
        row.languages.push(scope.language)
      }
      row.browseBlocked = row.browseBlocked || !scopeIsConsented(scope)
      byPath.set(member.path, row)
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function resolveCodePanelMemberDirectory(
  workspaceRoot: string,
  memberPath: string
): string {
  if (isRuntimePathAbsolute(memberPath)) {
    return memberPath
  }
  return memberPath === '.' ? workspaceRoot : joinPath(workspaceRoot, memberPath)
}

export function getCodePanelKeptEmptyLanguages(
  scopes: readonly CodeIntelligenceScope[]
): CodeIntelligenceLanguage[] {
  return scopes.filter((scope) => scope.members.length === 0).map((scope) => scope.language)
}
