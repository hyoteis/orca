import { describe, expect, it } from 'vitest'
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  OUTLINE_SUPPORTED_LANGUAGES,
  enclosingOutlineRowKey,
  filterOutlineRows,
  outlineLanguageFamily,
  outlineRowsFromDocumentSymbols,
  resolveOutlineAutoScope,
  resolveOutlineTier,
  sortOutlineRows,
  type OutlineRange,
  type OutlineSymbolRow
} from './outline-model'

function scope(overrides: Partial<CodeIntelligenceScope>): CodeIntelligenceScope {
  return {
    id: 'local:worktree:repo-1:python',
    name: 'repo-1',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/ws/repo-1',
    language: 'python',
    members: [{ path: '.', visibleResults: true }],
    serverSource: { type: 'automatic' },
    enabled: true,
    revision: 1,
    ...overrides
  }
}

const freshConsent = {
  configurationFingerprint: 'fp',
  grantedAt: 1,
  authorizedMembers: [{ path: '.', visibleResults: true }] as CodeIntelligenceScope['members']
}

describe('resolveOutlineTier', () => {
  it('marks languages outside the supported set as unsupported', () => {
    expect(resolveOutlineTier({ language: 'typescript', scope: null })).toEqual({
      kind: 'unsupported'
    })
    expect(
      resolveOutlineTier({ language: 'markdown', scope: scope({ language: 'python' }) })
    ).toEqual({ kind: 'unsupported' })
  })

  it('marks a supported file with no covering scope as unavailable (no scope)', () => {
    expect(resolveOutlineTier({ language: 'python', scope: null })).toEqual({
      kind: 'unavailable',
      reason: 'no-scope'
    })
  })

  it('marks a covered scope that was never consented as unavailable (consent)', () => {
    expect(resolveOutlineTier({ language: 'python', scope: scope({}) })).toEqual({
      kind: 'unavailable',
      reason: 'consent'
    })
  })

  it('marks a scope whose consent no longer matches its members as unavailable (consent)', () => {
    expect(
      resolveOutlineTier({
        language: 'python',
        scope: scope({
          members: [{ path: 'src', visibleResults: true }],
          consent: freshConsent
        })
      })
    ).toEqual({ kind: 'unavailable', reason: 'consent' })
  })

  it('resolves a consented enabled scope to the semantic tier', () => {
    expect(
      resolveOutlineTier({ language: 'python', scope: scope({ consent: freshConsent }) })
    ).toEqual({ kind: 'semantic' })
  })

  it('tiers C++ family languages through their cpp scope (#100)', () => {
    const cppScope = scope({ language: 'cpp', consent: freshConsent })
    expect(resolveOutlineTier({ language: 'cpp', scope: cppScope })).toEqual({
      kind: 'semantic'
    })
    expect(resolveOutlineTier({ language: 'c', scope: null })).toEqual({
      kind: 'unavailable',
      reason: 'no-scope'
    })
    expect(resolveOutlineTier({ language: 'objective-cpp', scope: cppScope })).toEqual({
      kind: 'semantic'
    })
  })

  it('treats a disabled scope like no scope', () => {
    expect(
      resolveOutlineTier({
        language: 'python',
        scope: scope({ enabled: false, consent: freshConsent })
      })
    ).toEqual({ kind: 'unavailable', reason: 'no-scope' })
  })
})

describe('outlineRowsFromDocumentSymbols', () => {
  const range = (line: number) => ({
    start: { line, character: 0 },
    end: { line, character: 4 }
  })

  it('projects a hierarchical DocumentSymbol tree into nested rows', () => {
    const symbols: DocumentSymbol[] = [
      {
        name: 'Renderer',
        kind: 5, // Class
        range: range(0),
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
        children: [
          {
            name: 'draw',
            kind: 6, // Method
            range: range(2),
            selectionRange: range(2)
          }
        ]
      }
    ]
    expect(outlineRowsFromDocumentSymbols(symbols)).toEqual([
      {
        key: 'Renderer@1',
        name: 'Renderer',
        kind: 5,
        line: 1,
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
        span: range(0),
        children: [
          {
            key: 'draw@3',
            name: 'draw',
            kind: 6,
            line: 3,
            range: range(2),
            span: range(2),
            children: []
          }
        ]
      }
    ])
  })

  it('uses the symbol extent as span for cursor-follow containment', () => {
    const symbols: DocumentSymbol[] = [
      {
        name: 'Renderer',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }
      }
    ]
    const [row] = outlineRowsFromDocumentSymbols(symbols)
    expect(row?.span).toEqual({ start: { line: 0, character: 0 }, end: { line: 40, character: 0 } })
    expect(row?.range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 14 }
    })
  })

  it('nests a flat SymbolInformation list by containerName in position order', () => {
    const symbols: SymbolInformation[] = [
      { name: 'Renderer', kind: 5, location: { uri: 'file:///w/renderer.py', range: range(0) } },
      {
        name: 'draw',
        kind: 6,
        containerName: 'Renderer',
        location: { uri: 'file:///w/renderer.py', range: range(4) }
      },
      {
        name: 'flush',
        kind: 6,
        containerName: 'Renderer.draw',
        location: { uri: 'file:///w/renderer.py', range: range(2) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Renderer')
    // Siblings sort by position: flush (line 3) precedes draw (line 5).
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['flush', 'draw'])
  })

  it('attaches a flat symbol to its deepest resolvable container chain segment', () => {
    const symbols: SymbolInformation[] = [
      { name: 'Renderer', kind: 5, location: { uri: 'file:///w/renderer.py', range: range(0) } },
      {
        name: 'helper',
        kind: 12,
        containerName: 'Renderer.draw',
        location: { uri: 'file:///w/renderer.py', range: range(1) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    // No 'draw' row exists, so helper nests under Renderer, not at the root.
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['helper'])
  })

  it('nests flat C++ symbols under ::-qualified container chains (#105)', () => {
    const symbols: SymbolInformation[] = [
      { name: 'ns', kind: 3, location: { uri: 'file:///w/a.cpp', range: range(0) } },
      {
        name: 'MyClass',
        kind: 5,
        containerName: 'ns',
        location: { uri: 'file:///w/a.cpp', range: range(1) }
      },
      {
        name: 'method',
        kind: 6,
        containerName: 'ns::MyClass',
        location: { uri: 'file:///w/a.cpp', range: range(2) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['ns'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['MyClass'])
    expect(rows[0]?.children[0]?.children.map((row) => row.name)).toEqual(['method'])
  })

  it('nests under a ::-container even when its own container row is missing (#105)', () => {
    // clangd qualifies containers but not names; MyClass lands at the root when
    // the ns row is unreported, and method must still find it there.
    const symbols: SymbolInformation[] = [
      {
        name: 'MyClass',
        kind: 5,
        containerName: 'ns',
        location: { uri: 'file:///w/a.cpp', range: range(0) }
      },
      {
        name: 'method',
        kind: 6,
        containerName: 'ns::MyClass',
        location: { uri: 'file:///w/a.cpp', range: range(1) }
      },
      {
        name: 'field',
        kind: 8,
        containerName: 'MyClass',
        location: { uri: 'file:///w/a.cpp', range: range(2) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['MyClass'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['method', 'field'])
  })

  it('suffix-retries dotted containers the same as ::-chains (#105)', () => {
    // Retry is separator-agnostic by design: container A.B with no A row still
    // nests under a root-level B rather than dropping to the root.
    const symbols: SymbolInformation[] = [
      { name: 'B', kind: 5, location: { uri: 'file:///w/a.py', range: range(0) } },
      {
        name: 'run',
        kind: 6,
        containerName: 'A.B',
        location: { uri: 'file:///w/a.py', range: range(1) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    expect(rows.map((row) => row.name)).toEqual(['B'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['run'])
  })

  it('falls back to the deepest resolvable ::-chain ancestor (#105)', () => {
    const symbols: SymbolInformation[] = [
      { name: 'Outer', kind: 5, location: { uri: 'file:///w/a.cpp', range: range(0) } },
      {
        name: 'value',
        kind: 13,
        containerName: 'Outer::Inner',
        location: { uri: 'file:///w/a.cpp', range: range(1) }
      }
    ]
    const rows = outlineRowsFromDocumentSymbols(symbols)
    // No Inner row exists, so value nests under Outer, not at the root.
    expect(rows.map((row) => row.name)).toEqual(['Outer'])
    expect(rows[0]?.children.map((row) => row.name)).toEqual(['value'])
  })

  it('keeps a flat symbol without a resolvable container at the root', () => {
    const symbols: SymbolInformation[] = [
      {
        name: 'orphan',
        kind: 6,
        containerName: 'Missing',
        location: { uri: 'file:///w/renderer.py', range: range(1) }
      }
    ]
    expect(outlineRowsFromDocumentSymbols(symbols).map((row) => row.name)).toEqual(['orphan'])
  })

  it('sorts flat siblings by position', () => {
    const symbols: SymbolInformation[] = [
      { name: 'zed', kind: 12, location: { uri: 'file:///w/a.py', range: range(9) } },
      { name: 'alpha', kind: 12, location: { uri: 'file:///w/a.py', range: range(1) } }
    ]
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

describe('resolveOutlineAutoScope', () => {
  const workspace = {
    repoId: 'repo-1',
    repoName: 'repo-1',
    repoPath: '/ws/repo-1',
    isFolder: false
  }

  it('creates a whole-root outline-auto scope on a local host', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'local',
        language: 'python',
        scopeName: 'repo-1 Python (Outline)',
        scopes: [],
        declinedAutoScopeIds: []
      })
    ).toEqual({
      kind: 'create',
      scope: expect.objectContaining({
        id: 'local:worktree:repo-1:python',
        name: 'repo-1 Python (Outline)',
        origin: 'outline-auto',
        workspaceRoot: '/ws/repo-1',
        members: [{ path: '.', visibleResults: true }],
        serverSource: { type: 'automatic' },
        enabled: true
      })
    })
  })

  it('keys folder repos under the folder workspace', () => {
    const decision = resolveOutlineAutoScope({
      workspace: { ...workspace, isFolder: true },
      executionHostId: 'local',
      language: 'cpp',
      scopeName: 'n',
      scopes: [],
      declinedAutoScopeIds: []
    })
    expect(decision.kind === 'create' && decision.scope.workspaceKey).toBe('folder:repo-1')
  })

  it('creates once: skips when any scope already holds the deterministic id', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'local',
        language: 'python',
        scopeName: 'n',
        scopes: [scope({ enabled: false })],
        declinedAutoScopeIds: []
      })
    ).toEqual({ kind: 'exists' })
  })

  it('prefers exists over declined when the user manually recreated the scope', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'local',
        language: 'python',
        scopeName: 'n',
        scopes: [scope({ origin: undefined })],
        declinedAutoScopeIds: ['local:worktree:repo-1:python']
      })
    ).toEqual({ kind: 'exists' })
  })

  it('never resurrects a deleted auto scope recorded in the declined list', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'local',
        language: 'python',
        scopeName: 'n',
        scopes: [],
        declinedAutoScopeIds: ['local:worktree:repo-1:python']
      })
    ).toEqual({ kind: 'declined' })
  })

  it('refuses to auto-create on SSH hosts', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'ssh:box',
        language: 'python',
        scopeName: 'n',
        scopes: [],
        declinedAutoScopeIds: []
      })
    ).toEqual({ kind: 'remote-host' })
  })

  it('refuses to auto-create on runtime hosts', () => {
    expect(
      resolveOutlineAutoScope({
        workspace,
        executionHostId: 'runtime:env-1',
        language: 'python',
        scopeName: 'n',
        scopes: [],
        declinedAutoScopeIds: []
      })
    ).toEqual({ kind: 'remote-host' })
  })

  it('answers no-workspace when no repo backs the file', () => {
    expect(
      resolveOutlineAutoScope({
        workspace: null,
        executionHostId: null,
        language: 'python',
        scopeName: 'n',
        scopes: [],
        declinedAutoScopeIds: []
      })
    ).toEqual({ kind: 'no-workspace' })
  })
})

describe('OUTLINE_SUPPORTED_LANGUAGES', () => {
  it('covers python and the C++ family', () => {
    expect([...OUTLINE_SUPPORTED_LANGUAGES]).toEqual([
      'python',
      'c',
      'cpp',
      'objective-c',
      'objective-cpp'
    ])
  })
})

describe('outlineLanguageFamily', () => {
  it('maps python and the C++ family to scope-resolution languages', () => {
    expect(outlineLanguageFamily('python')).toBe('python')
    expect(outlineLanguageFamily('c')).toBe('cpp')
    expect(outlineLanguageFamily('cpp')).toBe('cpp')
    expect(outlineLanguageFamily('objective-c')).toBe('cpp')
    expect(outlineLanguageFamily('typescript')).toBeNull()
  })
})
