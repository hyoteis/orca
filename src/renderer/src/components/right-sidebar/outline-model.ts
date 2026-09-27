import type {
  LanguageServerDocumentSymbolNode,
  LanguageServerDocumentSymbolPayload,
  LanguageServerSymbolInformationItem,
  LanguageServerSymbolRange
} from '../../../../shared/language-server-navigation-types'
import { regroupQualifiedRows } from './outline-qualified-regroup'

// This module stays pure (no store import chain) so node-side tests load it alone.

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

/** IPC payloads carry flat mirror ranges; the row tree keeps the nested shape. */
function toOutlineRange(range: LanguageServerSymbolRange): OutlineRange {
  return {
    start: { line: range.startLine, character: range.startCharacter },
    end: { line: range.endLine, character: range.endCharacter }
  }
}

function treeRows(symbols: readonly LanguageServerDocumentSymbolNode[]): OutlineSymbolRow[] {
  return symbols.map((symbol) => {
    const range = toOutlineRange(symbol.selectionRange ?? symbol.range)
    return {
      key: `${symbol.name}@${range.start.line + 1}`,
      name: symbol.name,
      kind: symbol.kind,
      line: range.start.line + 1,
      range,
      span: toOutlineRange(symbol.range),
      children: treeRows(symbol.children)
    }
  })
}

function byPosition(left: OutlineRange, right: OutlineRange): number {
  return left.start.line - right.start.line || left.start.character - right.start.character
}

/** Flat SymbolInformation items nest by containerName chains ('.' for Python,
 * '::' for clangd-qualified C++ containers); a symbol whose full chain is
 * missing lands on its deepest resolvable ancestor. */
function flatRows(symbols: readonly LanguageServerSymbolInformationItem[]): OutlineSymbolRow[] {
  const root: OutlineSymbolRow[] = []
  const ordered = [...symbols].sort(
    (left, right) =>
      left.range.startLine - right.range.startLine ||
      left.range.startCharacter - right.range.startCharacter
  )
  for (const symbol of ordered) {
    const range = toOutlineRange(symbol.range)
    const row: OutlineSymbolRow = {
      key: `${symbol.name}@${range.start.line + 1}`,
      name: symbol.name,
      kind: symbol.kind,
      line: range.start.line + 1,
      range,
      span: range,
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

/** Normalizes both documentSymbol payload shapes into the outline row tree;
 * ::-qualified names re-nest so flat results still render as a tree. */
export function outlineRowsFromDocumentSymbols(
  symbols: LanguageServerDocumentSymbolPayload | null
): OutlineSymbolRow[] {
  if (!symbols) {
    return []
  }
  const rows = symbols.kind === 'hierarchical' ? treeRows(symbols.roots) : flatRows(symbols.items)
  return regroupQualifiedRows(rows)
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
