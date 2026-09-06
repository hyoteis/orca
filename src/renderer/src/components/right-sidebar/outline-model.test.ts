import { describe, expect, it } from 'vitest'
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  OUTLINE_SUPPORTED_LANGUAGES,
  outlineLanguageFamily,
  outlineRowsFromDocumentSymbols,
  resolveOutlineTier
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
        children: [
          {
            key: 'draw@3',
            name: 'draw',
            kind: 6,
            line: 3,
            range: range(2),
            children: []
          }
        ]
      }
    ])
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
