import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import { isCodeIntelligenceConsentStale } from '../../../../shared/code-intelligence-scope'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import { joinPath, basename } from '../../lib/path'

export type CodePanelMemberRow = {
  path: string
  /** Row label — the workspace-root member ('.') shows the root folder name, not '.'. */
  displayName: string
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
        displayName: member.path === '.' ? basename(scope.workspaceRoot) : member.path,
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

/** Per-scope edits for removing one merged row; emptied scopes are kept (#63 decision 6). */
export function removeCodePanelMemberRow(
  scopes: readonly CodeIntelligenceScope[],
  memberPath: string
): CodeIntelligenceScope[] {
  return scopes
    .filter((scope) => scope.members.some((member) => member.path === memberPath))
    .map((scope) => ({
      ...scope,
      members: scope.members.filter((member) => member.path !== memberPath)
    }))
}
