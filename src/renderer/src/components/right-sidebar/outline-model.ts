import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { isCodeIntelligenceConsentStale } from '../../../../shared/code-intelligence-scope'

/** T1 covers Python; C++ joins with its document-symbol query (#100). */
export const OUTLINE_SUPPORTED_LANGUAGES = new Set(['python'])

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
