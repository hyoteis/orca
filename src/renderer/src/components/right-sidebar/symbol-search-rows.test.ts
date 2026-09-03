import { describe, expect, it } from 'vitest'
import { buildSymbolSearchRows } from './symbol-search-rows'
import { visibleWorkspaceSymbols } from '@/lib/language-server/code-intelligence-workspace'

const loc = (uri: string, line = 1) => ({
  uri,
  range: { start: { line, character: 2 }, end: { line, character: 6 } }
})

const scopeInfo = (
  scopeId: string,
  workspaceRoot: string,
  executionHostId = 'local'
): Map<string, { workspaceRoot: string; executionHostId: string }> =>
  new Map([[scopeId, { workspaceRoot, executionHostId }]])

describe('buildSymbolSearchRows', () => {
  it('flattens per-scope symbols into rows with kind label and workspace-relative path', () => {
    const rows = buildSymbolSearchRows(
      {
        results: [
          {
            scopeId: 's1',
            scopeName: 'proj',
            symbols: [
              { name: 'main', kind: 12, location: loc('file:///repo/app/main.py') },
              { name: 'Widget', kind: 5, location: loc('file:///repo/app/ui.py', 10) }
            ]
          }
        ],
        partial: false
      },
      scopeInfo('s1', '/repo')
    )

    expect(rows.map((row) => row.name)).toEqual(['main', 'Widget'])
    expect(rows[0]).toMatchObject({
      kindLabel: 'Function',
      displayPath: 'app/main.py',
      scopeName: 'proj',
      uri: 'file:///repo/app/main.py',
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } }
    })
    expect(rows[1].kindLabel).toBe('Class')
  })

  it('sorts by name so typing order stays stable across scopes', () => {
    const rows = buildSymbolSearchRows(
      {
        results: [
          {
            scopeId: 's1',
            scopeName: 'a',
            symbols: [{ name: 'zeta', kind: 12, location: loc('file:///repo/z.py') }]
          },
          {
            scopeId: 's2',
            scopeName: 'b',
            symbols: [{ name: 'alpha', kind: 12, location: loc('file:///repo/a.py') }]
          }
        ],
        partial: false
      },
      scopeInfo('s1', '/repo', 'local')
    )

    expect(rows.map((row) => row.name)).toEqual(['alpha', 'zeta'])
  })

  it('kinds outside the LSP 1..26 range fall back to the Symbol label', () => {
    const rows = buildSymbolSearchRows(
      {
        results: [
          {
            scopeId: 's1',
            scopeName: 'a',
            symbols: [
              { name: 'n', kind: 17, location: loc('file:///repo/a.py') },
              { name: 'x', kind: 99 as never, location: loc('file:///repo/b.py') }
            ]
          }
        ],
        partial: false
      },
      scopeInfo('s1', '/repo')
    )

    expect(rows.map((row) => row.kindLabel)).toEqual(['Boolean', 'Symbol'])
  })

  it('WorkspaceSymbol entries without a range keep a null range', () => {
    const rows = buildSymbolSearchRows(
      {
        results: [
          {
            scopeId: 's1',
            scopeName: 'a',
            symbols: [{ name: 'lazy', kind: 12, location: { uri: 'file:///repo/a.py' } }]
          }
        ],
        partial: false
      },
      scopeInfo('s1', '/repo')
    )

    expect(rows[0].range).toBeNull()
    expect(rows[0].displayPath).toBe('a.py')
  })

  it('paths outside the scope root keep the host path and carry the external flag', () => {
    const rows = buildSymbolSearchRows(
      {
        results: [
          {
            scopeId: 's1',
            scopeName: 'a',
            symbols: [{ name: 'extern', kind: 13, location: loc('file:///site-packages/x.py') }]
          }
        ],
        partial: false
      },
      scopeInfo('s1', '/repo')
    )

    expect(rows[0].displayPath).toBe('/site-packages/x.py')
    expect(rows[0].external).toBe(true)
  })
})

describe('buildSymbolSearchRows Phase 1 budget (#14)', () => {
  it('filters, groups, and projects 10,000 symbols within 100 ms', () => {
    const scope = {
      id: 's1',
      name: 'proj',
      executionHostId: 'local',
      workspaceKey: 'worktree:repo-1',
      workspaceRoot: '/repo',
      language: 'cpp',
      members: [{ path: '.', visibleResults: true }],
      serverSource: { type: 'automatic' },
      enabled: true,
      revision: 1
    } as const
    const symbols = Array.from({ length: 10_000 }, (_, index) => ({
      name: `symbol_${(9_999 - index).toString().padStart(5, '0')}`,
      kind: (index % 26) + 1,
      containerName: `ns${index % 50}`,
      location: loc(`file:///repo/src/mod${index % 50}/file${index % 500}.cpp`)
    }))
    const info = scopeInfo('s1', '/repo')

    const start = performance.now()
    const visible = visibleWorkspaceSymbols(scope, symbols)
    const rows = buildSymbolSearchRows(
      { results: [{ scopeId: 's1', scopeName: 'proj', symbols: visible }], partial: false },
      info
    )
    const elapsed = performance.now() - start

    expect(rows).toHaveLength(10_000)
    expect(rows[0]?.name).toBe('symbol_00000')
    expect(elapsed).toBeLessThan(100)
  })
})
