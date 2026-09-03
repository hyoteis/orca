// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { CPP_SEMANTIC_TOKEN_TYPES } from './cpp-semantic-token-mapping'

vi.mock('./cpp-definition-navigation', () => ({ getCppSemanticTokens: vi.fn() }))

import { getCppSemanticTokens } from './cpp-definition-navigation'
import {
  decodeCppSemanticTokenDecorations,
  installCppSemanticHighlightDecorations
} from './cpp-semantic-highlight-decorations'

describe('C++ semantic highlight decorations', () => {
  it('decodes relative semantic token positions into color classes', () => {
    const classType = CPP_SEMANTIC_TOKEN_TYPES.indexOf('class')
    const functionType = CPP_SEMANTIC_TOKEN_TYPES.indexOf('function')

    expect(
      decodeCppSemanticTokenDecorations(
        Uint32Array.from([0, 2, 4, classType, 0, 0, 6, 3, functionType, 0])
      )
    ).toEqual([
      {
        lineNumber: 1,
        startColumn: 3,
        endColumn: 7,
        className: 'orca-semantic-type'
      },
      {
        lineNumber: 1,
        startColumn: 9,
        endColumn: 12,
        className: 'orca-semantic-function'
      }
    ])
  })

  it('skips decorations for unmapped clangd token types', () => {
    const unknownType = CPP_SEMANTIC_TOKEN_TYPES.indexOf('unknown')

    expect(
      decodeCppSemanticTokenDecorations(Uint32Array.from([0, 0, 2, unknownType, 0]))
    ).toEqual([])
  })

  it('names the consent cause when stale authorization pauses highlighting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getCppSemanticTokens).mockRejectedValue(
      new Error('Error invoking remote method: Current code intelligence configuration requires launch consent')
    )
    const fakeEditor = {
      createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
      onDidChangeModelContent: () => ({ dispose: vi.fn() })
    }
    const dispose = installCppSemanticHighlightDecorations(
      {} as never,
      fakeEditor as never,
      () => ({}) as never
    )

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0][0]).toContain('re-authorize')
    dispose()
    warn.mockRestore()
  })

  it('keeps the generic failure line for unrelated errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getCppSemanticTokens).mockRejectedValue(new Error('clangd exited'))
    const fakeEditor = {
      createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
      onDidChangeModelContent: () => ({ dispose: vi.fn() })
    }
    const dispose = installCppSemanticHighlightDecorations(
      {} as never,
      fakeEditor as never,
      () => ({}) as never
    )

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0][0]).toContain('Semantic highlighting failed')
    dispose()
    warn.mockRestore()
  })
})
