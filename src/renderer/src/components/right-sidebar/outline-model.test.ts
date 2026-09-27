import { describe, expect, it } from 'vitest'
import type {
  LanguageServerDocumentSymbolNode,
  LanguageServerDocumentSymbolPayload,
  LanguageServerSymbolInformationItem,
  LanguageServerSymbolRange
} from '../../../../shared/language-server-navigation-types'
import {
  enclosingOutlineRowKey,
  filterOutlineRows,
  outlineRowsFromDocumentSymbols,
  sortOutlineRows,
  type OutlineRange,
  type OutlineSymbolRow
} from './outline-model'

const mirrorRange = (line: number): LanguageServerSymbolRange => ({
  startLine: line,
  startCharacter: 0,
  endLine: line,
  endCharacter: 4
})

const nestedRange = (line: number): OutlineRange => ({
  start: { line, character: 0 },
  end: { line, character: 4 }
})

function hierarchical(
  roots: LanguageServerDocumentSymbolNode[]
): LanguageServerDocumentSymbolPayload {
  return { kind: 'hierarchical', roots }
}

function flat(items: LanguageServerSymbolInformationItem[]): LanguageServerDocumentSymbolPayload {
  return { kind: 'flat', items }
}

describe('outlineRowsFromDocumentSymbols', () => {
  it('projects a hierarchical DocumentSymbol tree into nested rows', () => {
    const symbols = hierarchical([
      {
        name: 'Renderer',
        kind: 5, // Class
        range: mirrorRange(0),
        selectionRange: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 14 },
        children: [
          {
            name: 'draw',
            kind: 6, // Method
            range: mirrorRange(2),
            selectionRange: mirrorRange(2),
            children: []
          }
        ]
      }
    ])
    expect(outlineRowsFromDocumentSymbols(symbols)).toEqual([
      {
        key: 'Renderer@1',
        name: 'Renderer',
        kind: 5,
        line: 1,
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
        span: nestedRange(0),
        children: [
          {
            key: 'draw@3',
            name: 'draw',
            kind: 6,
            line: 3,
            range: nestedRange(2),
            span: nestedRange(2),
            children: []
          }
        ]
      }
    ])
  })

  it('uses the symbol extent as span for cursor-follow containment', () => {
    const symbols = hierarchical([
      {
        name: 'Renderer',
        kind: 5,
        range: { startLine: 0, startCharacter: 0, endLine: 40, endCharacter: 0 },
        selectionRange: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 14 },
        children: []
      }
    ])
    const [row] = outlineRowsFromDocumentSymbols(symbols)
    expect(row?.span).toEqual({ start: { line: 0, character: 0 }, end: { line: 40, character: 0 } })
    expect(row?.range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 14 }
    })
  })

  it('nests a flat SymbolInformation list by containerName in position order', () => {
    const symbols = flat([
      { name: 'Renderer', kind: 5, range: mirrorRange(0) },
      { name: 'draw', kind: 6, containerName: 'Renderer', range: mirrorRange(4) },
      { name: 'flush', kind: 6, containerName: 'Renderer.draw', range: mirrorRange(2) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Renderer')
    // Siblings sort by position: flush (line 3) precedes draw (line 5).
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['flush', 'draw'])
  })

  it('attaches a flat symbol to its deepest resolvable container chain segment', () => {
    const symbols = flat([
      { name: 'Renderer', kind: 5, range: mirrorRange(0) },
      { name: 'helper', kind: 12, containerName: 'Renderer.draw', range: mirrorRange(1) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    // No 'draw' row exists, so helper nests under Renderer, not at the root.
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['helper'])
  })

  it('nests flat C++ symbols under ::-qualified container chains (#105)', () => {
    const symbols = flat([
      { name: 'ns', kind: 3, range: mirrorRange(0) },
      { name: 'MyClass', kind: 5, containerName: 'ns', range: mirrorRange(1) },
      { name: 'method', kind: 6, containerName: 'ns::MyClass', range: mirrorRange(2) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['ns'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['MyClass'])
    expect(rows[0]?.children[0]?.children.map((row) => row.name)).toEqual(['method'])
  })

  it('nests under a ::-container even when its own container row is missing (#105)', () => {
    // clangd qualifies containers but not names; MyClass lands at the root when
    // the ns row is unreported, and method must still find it there.
    const symbols = flat([
      { name: 'MyClass', kind: 5, containerName: 'ns', range: mirrorRange(0) },
      { name: 'method', kind: 6, containerName: 'ns::MyClass', range: mirrorRange(1) },
      { name: 'field', kind: 8, containerName: 'MyClass', range: mirrorRange(2) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['MyClass'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['method', 'field'])
  })

  it('suffix-retries dotted containers the same as ::-chains (#105)', () => {
    // Retry is separator-agnostic by design: container A.B with no A row still
    // nests under a root-level B rather than dropping to the root.
    const symbols = flat([
      { name: 'B', kind: 5, range: mirrorRange(0) },
      { name: 'run', kind: 6, containerName: 'A.B', range: mirrorRange(1) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['B'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['run'])
  })

  it('falls back to the deepest resolvable ::-chain ancestor (#105)', () => {
    const symbols = flat([
      { name: 'Outer', kind: 5, range: mirrorRange(0) },
      { name: 'value', kind: 13, containerName: 'Outer::Inner', range: mirrorRange(1) }
    ])
    const rows = outlineRowsFromDocumentSymbols(symbols)
    // No Inner row exists, so value nests under Outer, not at the root.
    expect(rows.map((row) => row.name)).toEqual(['Outer'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['value'])
  })

  it('keeps a flat symbol without a resolvable container at the root', () => {
    const symbols = flat([
      { name: 'orphan', kind: 6, containerName: 'Missing', range: mirrorRange(1) }
    ])
    expect(outlineRowsFromDocumentSymbols(symbols).map((row) => row.name)).toEqual(['orphan'])
  })

  it('sorts flat siblings by position', () => {
    const symbols = flat([
      { name: 'zed', kind: 12, range: mirrorRange(9) },
      { name: 'alpha', kind: 12, range: mirrorRange(1) }
    ])
    expect(outlineRowsFromDocumentSymbols(symbols).map((row) => row.name)).toEqual(['alpha', 'zed'])
  })

  it('returns empty rows for null (no symbols)', () => {
    expect(outlineRowsFromDocumentSymbols(null)).toEqual([])
  })
})

function outlineRow(
  name: string,
  kind: number,
  span: OutlineRange,
  children: OutlineSymbolRow[] = []
): OutlineSymbolRow {
  return {
    key: `${name}@${span.start.line + 1}`,
    name,
    kind,
    line: span.start.line + 1,
    range: span,
    span,
    children
  }
}

function spanOf(startLine: number, endLine = startLine): OutlineRange {
  return { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } }
}

function interactionFixture(): OutlineSymbolRow[] {
  return [
    outlineRow('zed', 12, spanOf(0), [
      outlineRow('beta', 6, spanOf(1)),
      outlineRow('alpha', 6, spanOf(2)),
      outlineRow('value', 13, spanOf(3))
    ]),
    outlineRow('mid', 5, spanOf(4)),
    outlineRow('alpha', 12, spanOf(5))
  ]
}

describe('sortOutlineRows (#102)', () => {
  it('orders siblings by span position in the default mode', () => {
    const rows = [interactionFixture()[2], interactionFixture()[1], interactionFixture()[0]]
    expect(sortOutlineRows(rows, 'position').map((row) => row.name)).toEqual([
      'zed',
      'mid',
      'alpha'
    ])
  })

  it('orders siblings by name within each level, position as tie-break', () => {
    const sorted = sortOutlineRows(interactionFixture(), 'name')
    expect(sorted.map((row) => row.name)).toEqual(['alpha', 'mid', 'zed'])
    expect(sorted[2]?.children.map((row) => row.name)).toEqual(['alpha', 'beta', 'value'])
  })

  it('groups siblings by SymbolKind, position as tie-break', () => {
    const sorted = sortOutlineRows(interactionFixture(), 'kind')
    expect(sorted.map((row) => row.name)).toEqual(['mid', 'zed', 'alpha'])
    expect(sorted[1]?.children.map((row) => row.name)).toEqual(['beta', 'alpha', 'value'])
  })

  it('does not mutate the input rows', () => {
    const rows = interactionFixture()
    sortOutlineRows(rows, 'kind')
    expect(rows.map((row) => row.name)).toEqual(['zed', 'mid', 'alpha'])
  })
})

describe('filterOutlineRows (#102)', () => {
  it('keeps matching rows and ancestors of matches, drops the rest', () => {
    const filtered = filterOutlineRows(interactionFixture(), 'lph')
    expect(filtered.map((row) => row.name)).toEqual(['zed', 'alpha'])
    // zed survives only as the ancestor of the matching alpha.
    expect(filtered[0]?.children.map((row) => row.name)).toEqual(['alpha'])
  })

  it('matches case-insensitively as a substring', () => {
    expect(filterOutlineRows(interactionFixture(), 'ALPH').map((row) => row.name)).toEqual([
      'zed',
      'alpha'
    ])
  })

  it('hides non-matching children under a matching parent', () => {
    const filtered = filterOutlineRows(interactionFixture(), 'zed')
    expect(filtered.map((row) => row.name)).toEqual(['zed'])
    expect(filtered[0]?.children).toEqual([])
  })

  it('returns the rows unchanged for a blank query', () => {
    expect(filterOutlineRows(interactionFixture(), '  ')).toEqual(interactionFixture())
  })
})

describe('enclosingOutlineRowKey (#102)', () => {
  const nested = [
    outlineRow('Renderer', 5, spanOf(0, 40), [
      outlineRow('draw', 6, spanOf(10, 20), [outlineRow('flush', 6, spanOf(12, 15))])
    ])
  ]

  it('answers the deepest row whose span contains the cursor line', () => {
    expect(enclosingOutlineRowKey(nested, 13)).toBe('flush@13')
    expect(enclosingOutlineRowKey(nested, 17)).toBe('draw@11')
    expect(enclosingOutlineRowKey(nested, 30)).toBe('Renderer@1')
  })

  it('treats the span end line as containing', () => {
    expect(enclosingOutlineRowKey(nested, 20)).toBe('draw@11')
  })

  it('answers null outside every span', () => {
    expect(enclosingOutlineRowKey(nested, 60)).toBeNull()
  })
})
