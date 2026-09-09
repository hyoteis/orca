import { describe, expect, it } from 'vitest'
import { toClientDocumentUri, toServerFileUri } from './language-server-document-uri'
describe('language-server document mapping', () => {
  it('isolates identical paths by Host and scope', () => {
    const path = 'src/main.cpp'
    expect(
      toClientDocumentUri(
        { executionHostId: 'ssh:a', scopeId: 'engine', kind: 'clangd', revision: 1 },
        path
      )
    ).not.toBe(
      toClientDocumentUri(
        { executionHostId: 'ssh:b', scopeId: 'engine', kind: 'clangd', revision: 1 },
        path
      )
    )
  })
  it('maps Windows host paths to file URIs', () => {
    expect(toServerFileUri('C:\\repo\\a b.cpp')).toBe('file:///C:/repo/a%20b.cpp')
  })
  it('preserves UNC authority and encodes reserved characters', () => {
    expect(toServerFileUri('\\\\server\\share\\a #b.cpp')).toBe('file://server/share/a%20%23b.cpp')
  })
})

describe('LanguageServerClientRegistry mapping-health pushes (#136)', () => {
  it('forwards health-only scope changes without restarting or closing', async () => {
    const { LanguageServerClientRegistry } = await import('./language-server-client-registry')
    const sinks: ((change: { scopeId: string; revision: number | null; removed: boolean; mappingHealth?: unknown[] }) => void)[] = []
    const healthSeen: unknown[] = []
    const restarts: string[] = []
    const registry = new LanguageServerClientRegistry(
      {} as never,
      (key) => {
        restarts.push(key.scopeId)
      },
      {
        authorizeSession: async () => {
          throw new Error('unused')
        },
        onScopeChanged: (callback: (change: never) => void) => {
          sinks.push(callback as (typeof sinks)[number])
          return () => {}
        }
      } as never,
      (change) => {
        healthSeen.push(change)
      }
    )
    sinks[0]?.({
      scopeId: 'scope',
      revision: null,
      removed: false,
      mappingHealth: [{ id: 'm1', memberPath: 'one', compileDatabase: '/cdb/one.json', state: 'degraded' }]
    })
    expect(healthSeen).toHaveLength(1)
    expect(restarts).toEqual([])
    registry.dispose()
  })
})
