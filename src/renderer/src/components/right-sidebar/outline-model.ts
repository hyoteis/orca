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
  /** Symbol extent; cursor-follow containment (#102). */
  span: OutlineRange
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
      span: symbol.range,
      children: symbol.children ? treeRows(symbol.children) : []
    }
  })
}

function byPosition(left: OutlineRange, right: OutlineRange): number {
  return left.start.line - right.start.line || left.start.character - right.start.character
}

/** Flat SymbolInformation[] nests by containerName chains ('.' for Python,
 * '::' for clangd-qualified C++ containers); a symbol whose full chain is
 * missing lands on its deepest resolvable ancestor. */
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
      span: symbol.location.range,
      children: []
    }
    const segments = (symbol.containerName ?? '').split(/\.|::/).filter(Boolean)
    // Suffix retries longest-first: container names are fully qualified while
    // row names are not, so ns::MyClass must still match a MyClass sitting at
    // the root because its own container row went missing.
    let host: OutlineSymbolRow | null = null
    for (let skip = 0; skip < segments.length && !host; skip++) {
      let searchIn = root
      for (const segment of segments.slice(skip)) {
        const match = searchIn.find((candidate) => candidate.name === segment)
        if (!match) {
          break
        }
        host = match
        searchIn = match.children
      }
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

export type OutlineSortMode = 'position' | 'name' | 'kind'

/** Sibling ordering within each level; the hierarchy itself never flattens (#102). */
export function sortOutlineRows(
  rows: readonly OutlineSymbolRow[],
  mode: OutlineSortMode
): OutlineSymbolRow[] {
  const comparator =
    mode === 'name'
      ? (left: OutlineSymbolRow, right: OutlineSymbolRow) =>
          left.name.localeCompare(right.name) || byPosition(left.span, right.span)
      : mode === 'kind'
        ? (left: OutlineSymbolRow, right: OutlineSymbolRow) =>
            left.kind - right.kind || byPosition(left.span, right.span)
        : (left: OutlineSymbolRow, right: OutlineSymbolRow) => byPosition(left.span, right.span)
  return [...rows]
    .sort(comparator)
    .map((row) =>
      row.children.length ? { ...row, children: sortOutlineRows(row.children, mode) } : row
    )
}

/** Case-insensitive name filter keeping ancestors of matches; a matching parent
 * still narrows to its matching children (#102). */
export function filterOutlineRows(
  rows: readonly OutlineSymbolRow[],
  query: string
): OutlineSymbolRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...rows]
  }
  const walk = (rows: readonly OutlineSymbolRow[]): OutlineSymbolRow[] => {
    const kept: OutlineSymbolRow[] = []
    for (const row of rows) {
      const children = walk(row.children)
      if (row.name.toLowerCase().includes(needle) || children.length > 0) {
        kept.push({ ...row, children })
      }
    }
    return kept
  }
  return walk(rows)
}

/** Deepest row whose span contains the cursor line (0-based LSP); the
 * cursor-follow highlight key (#102). */
export function enclosingOutlineRowKey(
  rows: readonly OutlineSymbolRow[],
  cursorLine: number
): string | null {
  for (const row of rows) {
    if (cursorLine >= row.span.start.line && cursorLine <= row.span.end.line) {
      return enclosingOutlineRowKey(row.children, cursorLine) ?? row.key
    }
  }
  return null
}
