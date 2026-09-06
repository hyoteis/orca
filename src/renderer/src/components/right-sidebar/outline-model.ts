import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceScopeId,
  getCodeIntelligenceWorkspaceKey,
  isCodeIntelligenceConsentStale
} from '../../../../shared/code-intelligence-scope'
import { createRepositoryCodeIntelligenceScope } from '../settings/repository-code-intelligence-scope'

// Mirrors CPP_LANGUAGES without importing it: this module stays pure (no store
// import chain) so node-side tests load it alone.
const CPP_FAMILY_LANGUAGES = new Set(['c', 'cpp', 'objective-c', 'objective-cpp'])

export const OUTLINE_SUPPORTED_LANGUAGES = new Set(['python', ...CPP_FAMILY_LANGUAGES])

/** Scope-resolution family for the active file; null means unsupported. */
export function outlineLanguageFamily(language: string): CodeIntelligenceLanguage | null {
  if (CPP_FAMILY_LANGUAGES.has(language)) {
    return 'cpp'
  }
  return language === 'python' ? 'python' : null
}

export type OutlineRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type OutlineSymbolRow = {
  key: string
  name: string
  /** LSP SymbolKind 1..26; the panel maps it to a monochrome kind icon. */
  kind: number
  /** 1-based line of the symbol name; shown on row hover. */
  line: number
  /** Name range the shared reveal path jumps to. */
  range: OutlineRange
  children: OutlineSymbolRow[]
}

export type OutlineTier =
  | { kind: 'unsupported' }
  | { kind: 'unavailable'; reason: 'no-scope' | 'consent' }
  | { kind: 'semantic' }

function scopeIsConsented(scope: CodeIntelligenceScope): boolean {
  return scope.consent !== undefined && !isCodeIntelligenceConsentStale(scope)
}

/** Tier resolution per ADR 0003; the panel queries only on the semantic tier. */
export function resolveOutlineTier({
  language,
  scope
}: {
  language: string
  scope: CodeIntelligenceScope | null
}): OutlineTier {
  if (!OUTLINE_SUPPORTED_LANGUAGES.has(language)) {
    return { kind: 'unsupported' }
  }
  // findCodeIntelligenceScope already drops disabled scopes; keep the model
  // total so callers can pass any resolved scope.
  if (!scope || !scope.enabled) {
    return { kind: 'unavailable', reason: 'no-scope' }
  }
  if (!scopeIsConsented(scope)) {
    return { kind: 'unavailable', reason: 'consent' }
  }
  return { kind: 'semantic' }
}

export type OutlineAutoScopeWorkspace = {
  repoId: string
  repoName: string
  repoPath: string
  isFolder: boolean
}

export type OutlineAutoScopeDecision =
  | { kind: 'create'; scope: CodeIntelligenceScope }
  | { kind: 'exists' }
  | { kind: 'declined' }
  | { kind: 'remote-host' }
  | { kind: 'no-workspace' }

/** Zero-config default scope (ADR 0003 tier 2): create once on local hosts,
 * never resurrect a deleted one, never auto-create off-host. Exists-check runs
 * before declined so a manually recreated scope is left alone. */
export function resolveOutlineAutoScope(args: {
  workspace: OutlineAutoScopeWorkspace | null
  executionHostId: ExecutionHostId | null
  language: CodeIntelligenceLanguage
  /** Localized origin-marking name; persisted verbatim on creation. */
  scopeName: string
  scopes: readonly CodeIntelligenceScope[]
  /** Scope ids whose outline-auto scope the user deleted (never recreate). */
  declinedAutoScopeIds: readonly string[]
}): OutlineAutoScopeDecision {
  if (!args.workspace || !args.executionHostId) {
    return { kind: 'no-workspace' }
  }
  if (args.executionHostId !== 'local') {
    return { kind: 'remote-host' }
  }
  const id = getCodeIntelligenceScopeId({
    executionHostId: args.executionHostId,
    workspaceKey: getCodeIntelligenceWorkspaceKey(args.workspace.repoId, args.workspace.isFolder),
    language: args.language
  })
  if (args.scopes.some((scope) => scope.id === id)) {
    return { kind: 'exists' }
  }
  if (args.declinedAutoScopeIds.includes(id)) {
    return { kind: 'declined' }
  }
  return {
    kind: 'create',
    scope: {
      ...createRepositoryCodeIntelligenceScope({
        repoId: args.workspace.repoId,
        repoName: args.workspace.repoName,
        repoPath: args.workspace.repoPath,
        isFolder: args.workspace.isFolder,
        executionHostId: args.executionHostId,
        language: args.language
      }),
      name: args.scopeName,
      origin: 'outline-auto'
    }
  }
}

function treeRows(symbols: readonly DocumentSymbol[]): OutlineSymbolRow[] {
  return symbols.map((symbol) => {
    const range = symbol.selectionRange ?? symbol.range
    return {
      key: `${symbol.name}@${range.start.line + 1}`,
      name: symbol.name,
      kind: symbol.kind,
      line: range.start.line + 1,
      range,
      children: symbol.children ? treeRows(symbol.children) : []
    }
  })
}

function byPosition(left: OutlineRange, right: OutlineRange): number {
  return left.start.line - right.start.line || left.start.character - right.start.character
}

/** Flat SymbolInformation[] nests by dotted containerName chains; a symbol whose
 * full chain is missing lands on its deepest resolvable ancestor. */
function flatRows(symbols: readonly SymbolInformation[]): OutlineSymbolRow[] {
  const root: OutlineSymbolRow[] = []
  const ordered = [...symbols].sort((left, right) =>
    byPosition(left.location.range, right.location.range)
  )
  for (const symbol of ordered) {
    const row: OutlineSymbolRow = {
      key: `${symbol.name}@${symbol.location.range.start.line + 1}`,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.location.range.start.line + 1,
      range: symbol.location.range,
      children: []
    }
    let searchIn = root
    let host: OutlineSymbolRow | null = null
    for (const segment of (symbol.containerName ?? '').split('.').filter(Boolean)) {
      const match = searchIn.find((candidate) => candidate.name === segment)
      if (!match) {
        break
      }
      host = match
      searchIn = match.children
    }
    ;(host ? host.children : root).push(row)
  }
  return root
}

/** Normalizes both LSP documentSymbol result shapes into the outline row tree. */
export function outlineRowsFromDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[] | null
): OutlineSymbolRow[] {
  if (!symbols || symbols.length === 0) {
    return []
  }
  return 'location' in symbols[0]
    ? flatRows(symbols as SymbolInformation[])
    : treeRows(symbols as DocumentSymbol[])
}
