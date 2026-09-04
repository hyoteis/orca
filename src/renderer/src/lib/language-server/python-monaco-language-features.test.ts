// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const showRightSidebarSearch = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ showRightSidebarSearch })
  }
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn() }
}))

const navigation = vi.hoisted(() => ({
  PYTHON_LANGUAGES: new Set(['python']),
  getPythonSessionState: vi.fn(),
  subscribePythonDiagnostics: vi.fn(() => () => {}),
  getPythonDiagnostics: vi.fn(),
  getPythonHover: vi.fn(),
  getPythonDocumentSymbols: vi.fn(),
  getPythonReferences: vi.fn(),
  resolvePythonDefinition: vi.fn()
}))

vi.mock('./python-definition-navigation', () => navigation)
vi.mock('./definition-link-affordance', () => ({
  installDefinitionLinkAffordance: vi.fn(() => () => {})
}))

vi.mock('./semantic-monaco-stack', () => ({
  createSemanticMonacoStack: () => ({ installProviders: vi.fn() })
}))

import { toast } from 'sonner'
import {
  lspDiagnosticToMonacoMarkers,
  lspSymbolsToMonaco,
  pythonDefinitionFallbackAction,
  textSearchFallback
} from './python-monaco-language-features'
import type { PythonCodeIntelligenceRequest } from './python-definition-navigation'

const request: PythonCodeIntelligenceRequest = {
  fileId: 'f1',
  filePath: '/repo/main.py',
  relativePath: 'main.py',
  worktreeId: 'demo',
  language: 'python',
  text: 'x = 1',
  documentVersion: 1,
  lineNumber: 1,
  column: 1
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('python definition fallback router', () => {
  it('routes to text search when the session is unavailable', () => {
    navigation.getPythonSessionState.mockReturnValue({ quality: 'text-search' })
    expect(pythonDefinitionFallbackAction(request)).toEqual({ type: 'text-search' })
  })

  it('only offers the explicit search action after a semantic no-result', () => {
    navigation.getPythonSessionState.mockReturnValue({
      quality: 'semantic',
      capabilities: { definition: true }
    })
    expect(pythonDefinitionFallbackAction(request)).toEqual({ type: 'offer-search' })
  })

  it('routes to text search when the server lacks definition capability', () => {
    navigation.getPythonSessionState.mockReturnValue({
      quality: 'semantic',
      capabilities: { definition: false }
    })
    expect(pythonDefinitionFallbackAction(request)).toEqual({ type: 'text-search' })
  })

  it('opens the labelled text search in the sidebar', () => {
    textSearchFallback(request, 'run_job')
    expect(showRightSidebarSearch).toHaveBeenCalledWith({ query: 'run_job' })
    expect(toast.info).toHaveBeenCalled()
  })

  it('does nothing for non-python documents', () => {
    expect(
      pythonDefinitionFallbackAction({ ...request, language: 'cpp' })
    ).toBeNull()
    textSearchFallback({ ...request, language: 'cpp' }, 'word')
    expect(showRightSidebarSearch).not.toHaveBeenCalled()
  })
})

describe('diagnostic marker mapping', () => {
  it('maps LSP diagnostics to monaco markers with 1-based ranges', () => {
    const markers = lspDiagnosticToMonacoMarkers([
      {
        range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
        severity: 1,
        message: 'bad import'
      },
      {
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
        message: 'unrated'
      }
    ])
    expect(markers[0]).toMatchObject({
      startLineNumber: 1,
      startColumn: 3,
      endColumn: 6,
      severity: 8,
      message: 'bad import'
    })
    // Missing severity defaults to Error, mirroring vscode-languageclient.
    expect(markers[1].severity).toBe(8)
  })
})

describe('document symbol mapping', () => {
  it('maps hierarchical LSP symbols with children and shifted kinds', () => {
    const symbols = lspSymbolsToMonaco([
      {
        name: 'A',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        children: [
          {
            name: 'm',
            kind: 6,
            range: { start: { line: 1, character: 4 }, end: { line: 2, character: 0 } },
            selectionRange: {
              start: { line: 1, character: 4 },
              end: { line: 1, character: 5 }
            }
          }
        ]
      }
    ])
    expect(symbols[0]).toMatchObject({
      name: 'A',
      kind: 4,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 10, endColumn: 1 },
      selectionRange: { startLineNumber: 1, startColumn: 7 }
    })
    expect(symbols[0].children?.[0]).toMatchObject({ name: 'm', kind: 5 })
  })

  it('flattens SymbolInformation results into document symbols', () => {
    const symbols = lspSymbolsToMonaco([
      {
        name: 'top',
        kind: 13,
        location: {
          uri: 'file:///repo/main.py',
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }
        }
      }
    ])
    expect(symbols[0]).toMatchObject({
      name: 'top',
      kind: 12,
      range: { startLineNumber: 3, endLineNumber: 3 }
    })
  })
})
