import { describe, expect, it } from 'vitest'
import type { SymbolInformation } from 'vscode-languageserver-protocol'
import {
  outlineRowsFromDocumentSymbols,
  type OutlineSymbolRow
} from './outline-model'
import { regroupQualifiedRows } from './outline-qualified-regroup'

const range = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 4 }
})

function row(
  name: string,
  kind: number,
  line: number,
  children: OutlineSymbolRow[] = []
): OutlineSymbolRow {
  return {
    key: `${name}@${line}`,
    name,
    kind,
    line,
    range: range(line - 1),
    span: range(line - 1),
    children
  }
}

describe('regroupQualifiedRows', () => {
  it('nests qualified rows under an existing class row with short names', () => {
    const out = regroupQualifiedRows([
      row('MyClass', 5, 1),
      row('MyClass::count_', 8, 2),
      row('MyClass::method', 6, 5),
      row('free_function', 12, 30)
    ])
    expect(out.map((r) => r.name)).toEqual(['MyClass', 'free_function'])
    expect(out[0]?.children.map((r) => r.name)).toEqual(['count_', 'method'])
  })

  it('synthesizes containers for missing rows (class lives in another file)', () => {
    const out = regroupQualifiedRows([row('MyClass::method', 6, 9)])
    expect(out.map((r) => r.name)).toEqual(['MyClass'])
    expect(out[0]?.key).toBe('qualified:MyClass')
    expect(out[0]?.kind).toBe(3)
    expect(out[0]?.children.map((r) => r.name)).toEqual(['method'])
    // Reveal still lands: the synthetic row borrows the first child's range.
    expect(out[0]?.range).toEqual(range(8))
  })

  it('keeps overloads as siblings with their own keys', () => {
    const out = regroupQualifiedRows([
      row('MyClass', 5, 1),
      row('MyClass::draw', 6, 5),
      row('MyClass::draw', 6, 12)
    ])
    expect(out[0]?.children.map((r) => `${r.name}@${r.line}`)).toEqual(['draw@5', 'draw@12'])
  })

  it('is idempotent for short names and already-nested trees', () => {
    const rows = [row('MyClass', 5, 1, [row('method', 6, 5)])]
    expect(regroupQualifiedRows(rows)).toEqual(rows)
    expect(regroupQualifiedRows(regroupQualifiedRows(rows))).toEqual(rows)
  })

  it('collapses the duplicate segment when a nested row repeats its ancestor', () => {
    const out = regroupQualifiedRows([row('MyClass', 5, 1, [row('MyClass::method', 6, 5)])])
    expect(out[0]?.children.map((r) => r.name)).toEqual(['method'])
  })
})

describe('outlineRowsFromDocumentSymbols with qualified flat names', () => {
  it('re-nests qualified flat SymbolInformation (clangd fallback shape)', () => {
    const symbols: SymbolInformation[] = [
      { name: 'MyClass', kind: 5, location: { uri: 'file:///w/a.cpp', range: range(0) } },
      {
        name: 'MyClass::method',
        kind: 6,
        containerName: 'MyClass',
        location: { uri: 'file:///w/a.cpp', range: range(2) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((r) => r.name)).toEqual(['MyClass'])
    expect(rows[0]?.children.map((r) => r.name)).toEqual(['method'])
  })
})
