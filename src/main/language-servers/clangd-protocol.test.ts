import { describe, expect, it } from 'vitest'
import {
  buildClangdInitializeParams,
  createClangdIndexingTracker,
  mapClangdDocumentSymbolResult,
  mapClangdLocationResult
} from './clangd-protocol'

const toPath = (uri: string): string => uri

/** LSP wire range helper (0-based, start/end line+character). */
const wireRange = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
})

describe('mapClangdLocationResult', () => {
  it('maps an array of locations to semantic locations', () => {
    const result = mapClangdLocationResult(
      [
        {
          uri: 'file:///D:/a.hpp',
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
        },
        {
          uri: 'file:///D:/b.cpp',
          range: { start: { line: 8, character: 0 }, end: { line: 8, character: 3 } }
        }
      ],
      toPath
    )
    expect(result).toEqual([
      {
        path: 'file:///D:/a.hpp',
        range: { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 5 }
      },
      {
        path: 'file:///D:/b.cpp',
        range: { startLine: 8, startCharacter: 0, endLine: 8, endCharacter: 3 }
      }
    ])
  })

  it('normalizes a bare single Location object (not an array) to a one-element list', () => {
    const result = mapClangdLocationResult(
      {
        uri: 'file:///D:/a.hpp',
        range: { start: { line: 4, character: 6 }, end: { line: 4, character: 9 } }
      },
      toPath
    )
    expect(result).toEqual([
      {
        path: 'file:///D:/a.hpp',
        range: { startLine: 4, startCharacter: 6, endLine: 4, endCharacter: 9 }
      }
    ])
  })

  it('returns an empty list for a null result (symbol with no references/declaration)', () => {
    expect(mapClangdLocationResult(null, toPath)).toEqual([])
    expect(mapClangdLocationResult(undefined, toPath)).toEqual([])
    expect(mapClangdLocationResult([], toPath)).toEqual([])
  })

  it('skips malformed items missing uri or range endpoints', () => {
    const result = mapClangdLocationResult(
      [
        {
          uri: 'file:///D:/ok.hpp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        },
        { uri: 'file:///D:/no-range.hpp' },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: 'file:///D:/partial.hpp', range: { start: { line: 0, character: 0 } } }
      ],
      toPath
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('file:///D:/ok.hpp')
  })
})

describe('buildClangdInitializeParams — documentSymbol capability', () => {
  it('declares dynamicRegistration:false + hierarchicalDocumentSymbolSupport:true', () => {
    const params = buildClangdInitializeParams('D:\\p', 42, (p) => `file:///${encodeURI(p)}`)
    expect(isRecord(params)).toBe(true)
    const capabilities = isRecord(params) ? params.capabilities : null
    const textDocument = isRecord(capabilities) ? capabilities.textDocument : null
    expect(isRecord(textDocument)).toBe(true)
    expect(isRecord(textDocument) ? textDocument.documentSymbol : null).toEqual({
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true
    })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('mapClangdDocumentSymbolResult', () => {
  it('maps a hierarchical DocumentSymbol[] to a roots tree, copying children recursively', () => {
    const payload = mapClangdDocumentSymbolResult([
      {
        name: 'ns',
        kind: 3,
        range: wireRange(0, 0, 10, 0),
        selectionRange: wireRange(0, 10, 0, 12),
        children: [
          {
            name: 'Cls',
            kind: 5,
            range: wireRange(1, 0, 8, 1),
            selectionRange: wireRange(1, 6, 1, 9),
            children: []
          },
          // `children` omitted is legal on the wire — the mirror node gets [].
          {
            name: 'fn',
            kind: 12,
            range: wireRange(9, 0, 9, 5),
            selectionRange: wireRange(9, 0, 9, 2)
          }
        ]
      }
    ])
    expect(payload).toEqual({
      kind: 'hierarchical',
      roots: [
        {
          name: 'ns',
          kind: 3,
          range: { startLine: 0, startCharacter: 0, endLine: 10, endCharacter: 0 },
          selectionRange: { startLine: 0, startCharacter: 10, endLine: 0, endCharacter: 12 },
          children: [
            {
              name: 'Cls',
              kind: 5,
              range: { startLine: 1, startCharacter: 0, endLine: 8, endCharacter: 1 },
              selectionRange: { startLine: 1, startCharacter: 6, endLine: 1, endCharacter: 9 },
              children: []
            },
            {
              name: 'fn',
              kind: 12,
              range: { startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 5 },
              selectionRange: { startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 2 },
              children: []
            }
          ]
        }
      ]
    })
  })

  it('maps a flat SymbolInformation[] to items with location.range -> range + containerName passthrough', () => {
    const payload = mapClangdDocumentSymbolResult([
      {
        name: 'main',
        kind: 12,
        location: { uri: 'file:///D:/a.cpp', range: wireRange(0, 4, 0, 8) }
      },
      {
        name: 'x',
        kind: 13,
        containerName: 'main',
        location: { uri: 'file:///D:/a.cpp', range: wireRange(1, 0, 1, 1) }
      }
    ])
    expect(payload).toEqual({
      kind: 'flat',
      items: [
        {
          name: 'main',
          kind: 12,
          range: { startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 8 }
        },
        {
          name: 'x',
          kind: 13,
          range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 },
          containerName: 'main'
        }
      ]
    })
  })

  it('null/undefined/empty-array results become an empty hierarchical payload (truly empty file)', () => {
    expect(mapClangdDocumentSymbolResult(null)).toEqual({ kind: 'hierarchical', roots: [] })
    expect(mapClangdDocumentSymbolResult(undefined)).toEqual({ kind: 'hierarchical', roots: [] })
    expect(mapClangdDocumentSymbolResult([])).toEqual({ kind: 'hierarchical', roots: [] })
  })

  it('skips malformed items without throwing (hierarchical: bad name/kind/range; flat: missing location)', () => {
    const payload = mapClangdDocumentSymbolResult([
      {
        name: 'good',
        kind: 23,
        range: wireRange(0, 0, 1, 0),
        selectionRange: wireRange(0, 0, 0, 4),
        children: [
          {
            name: '',
            kind: 6,
            range: wireRange(0, 0, 0, 1),
            selectionRange: wireRange(0, 0, 0, 1)
          }, // empty name
          {
            name: 'bad-kind',
            kind: 27,
            range: wireRange(0, 0, 0, 1),
            selectionRange: wireRange(0, 0, 0, 1)
          },
          { name: 'no-range', kind: 6, selectionRange: wireRange(0, 0, 0, 1) },
          {
            name: 'ok-child',
            kind: 6,
            range: wireRange(0, 0, 0, 1),
            selectionRange: wireRange(0, 0, 0, 1)
          }
        ]
      },
      { name: 'no-selection-range', kind: 6, range: wireRange(2, 0, 2, 1) },
      null
    ])
    expect(payload).toEqual({
      kind: 'hierarchical',
      roots: [
        {
          name: 'good',
          kind: 23,
          range: { startLine: 0, startCharacter: 0, endLine: 1, endCharacter: 0 },
          selectionRange: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 4 },
          children: [
            {
              name: 'ok-child',
              kind: 6,
              range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
              selectionRange: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
              children: []
            }
          ]
        }
      ]
    })

    const flat = mapClangdDocumentSymbolResult([
      { name: 'no-location', kind: 12 },
      { name: 'partial', kind: 12, location: { uri: 'file:///D:/a.cpp' } },
      {
        name: 'fine',
        kind: 12,
        location: { uri: 'file:///D:/a.cpp', range: wireRange(3, 0, 3, 4) }
      }
    ])
    expect(flat).toEqual({
      kind: 'flat',
      items: [
        {
          name: 'fine',
          kind: 12,
          range: { startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 4 }
        }
      ]
    })
  })
})

describe('createClangdIndexingTracker', () => {
  it('begin/report/end project active state with the latest reported percentage', () => {
    const tracker = createClangdIndexingTracker()
    expect(
      tracker.reduce({ token: 'index', value: { kind: 'begin', title: 'background index' } })
    ).toEqual({ active: true })
    expect(tracker.reduce({ token: 'index', value: { kind: 'report', percentage: 42.7 } })).toEqual(
      { active: true, percentage: 42.7 }
    )
    expect(tracker.reduce({ token: 'index', value: { kind: 'end' } })).toEqual({ active: false })
  })

  it('keeps active while another token runs, falling back to its percentage on end', () => {
    const tracker = createClangdIndexingTracker()
    tracker.reduce({ token: 'a', value: { kind: 'begin' } })
    expect(tracker.reduce({ token: 'a', value: { kind: 'report', percentage: 10 } })).toEqual({
      active: true,
      percentage: 10
    })
    tracker.reduce({ token: 'b', value: { kind: 'begin', percentage: 0 } })
    // The most recently reported token wins the projected percentage.
    expect(tracker.reduce({ token: 'b', value: { kind: 'report', percentage: 50 } })).toEqual({
      active: true,
      percentage: 50
    })
    expect(tracker.reduce({ token: 'b', value: { kind: 'end' } })).toEqual({
      active: true,
      percentage: 10
    })
    expect(tracker.reduce({ token: 'a', value: { kind: 'end' } })).toEqual({ active: false })
  })

  it('returns undefined for events carrying no indexing projection', () => {
    const tracker = createClangdIndexingTracker()
    expect(tracker.reduce({ value: { kind: 'begin' } })).toBeUndefined() // no token
    expect(tracker.reduce(null)).toBeUndefined()
    tracker.reduce({ token: 'a', value: { kind: 'begin' } })
    // Unknown kinds are dropped — clangd reports non-indexing work on this channel.
    expect(tracker.reduce({ token: 'a', value: { kind: 'strange' } })).toBeUndefined()
    // A report for an unknown token never fabricates activity or percentage.
    expect(
      tracker.reduce({ token: 'ghost', value: { kind: 'report', percentage: 5 } })
    ).toBeUndefined()
  })
})
