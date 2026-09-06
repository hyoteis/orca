// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as WorkspaceModule from '@/lib/language-server/code-intelligence-workspace'
import type * as SemanticDocumentsModule from '@/lib/language-server/semantic-monaco-documents'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { OutlinePanel } from './OutlinePanel'

const mocks = vi.hoisted(() => ({
  getPythonDocumentSymbols: vi.fn(),
  getCppDocumentSymbols: vi.fn(),
  openDefinitionTargetInWorkspace: vi.fn(() => true),
  semanticDocumentEditorFor: vi.fn()
}))

vi.mock('@/lib/language-server/python-definition-navigation', () => ({
  getPythonDocumentSymbols: mocks.getPythonDocumentSymbols
}))

vi.mock('@/lib/language-server/cpp-definition-navigation', () => ({
  getCppDocumentSymbols: mocks.getCppDocumentSymbols
}))

vi.mock('@/lib/language-server/code-intelligence-workspace', async (importOriginal) => {
  // Keep the real pure path helpers — the hook resolves scopes with them.
  const actual = await importOriginal<typeof WorkspaceModule>()
  return {
    ...actual,
    openDefinitionTargetInWorkspace: mocks.openDefinitionTargetInWorkspace
  }
})

vi.mock('@/lib/language-server/semantic-monaco-documents', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticDocumentsModule>()
  return {
    ...actual,
    semanticDocumentEditorFor: mocks.semanticDocumentEditorFor
  }
})

function scopeFixture(overrides: Partial<CodeIntelligenceScope> = {}): CodeIntelligenceScope {
  return {
    id: 'local:worktree:repo-1:python',
    name: 'repo-1',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/ws/repo-1',
    language: 'python',
    members: [{ path: '.', visibleResults: true }],
    serverSource: { type: 'automatic' },
    consent: {
      configurationFingerprint: 'fp',
      grantedAt: 1,
      authorizedMembers: [{ path: '.', visibleResults: true }]
    },
    enabled: true,
    revision: 1,
    ...overrides
  }
}

type FileFixture = {
  id: string
  filePath: string
  relativePath: string
  language: string
}

function openFileFixture({ id, filePath, relativePath, language }: FileFixture) {
  return {
    id,
    filePath,
    relativePath,
    worktreeId: 'repo-1::/ws/repo-1',
    language,
    isDirty: false,
    mode: 'edit' as const
  }
}

function setState(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    activeWorktreeId: 'repo-1::/ws/repo-1',
    activeFileId: 'f1',
    activeTabType: 'editor',
    openFiles: [
      openFileFixture({
        id: 'f1',
        filePath: '/ws/repo-1/src/renderer.py',
        relativePath: 'src/renderer.py',
        language: 'python'
      })
    ],
    repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
    settings: { codeIntelligenceScopes: [scopeFixture()] },
    ...overrides
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
}

const treeSymbols = [
  {
    name: 'Renderer',
    kind: 5,
    range: { start: { line: 0, character: 6 }, end: { line: 40, character: 0 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
    children: [
      {
        name: 'draw',
        kind: 6,
        range: { start: { line: 10, character: 4 }, end: { line: 12, character: 9 } },
        selectionRange: { start: { line: 10, character: 7 }, end: { line: 10, character: 11 } }
      }
    ]
  }
]

beforeEach(() => {
  mocks.getPythonDocumentSymbols.mockReset()
  mocks.getCppDocumentSymbols.mockReset()
  mocks.openDefinitionTargetInWorkspace.mockClear()
  mocks.semanticDocumentEditorFor.mockReset()
  mocks.semanticDocumentEditorFor.mockReturnValue({
    editor: {},
    model: { getValue: () => 'class Renderer:', getVersionId: () => 7 }
  })
  setState()
})

afterEach(() => {
  // No `globals: true`, so Testing Library's auto-cleanup never runs.
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <OutlinePanel />
    </TooltipProvider>
  )
}

describe('OutlinePanel', () => {
  it('renders the header title and the active file chip', async () => {
    mocks.getPythonDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    expect(screen.getByText('Outline')).toBeInTheDocument()
    expect(await screen.findByText('renderer.py')).toBeInTheDocument()
  })

  it('renders the nested symbol tree expanded with kind icons and line numbers', async () => {
    mocks.getPythonDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    const parent = await screen.findByRole('button', { name: /Renderer/ })
    expect(parent).toBeInTheDocument()
    // Nested child renders without expanding (default expanded).
    expect(screen.getByRole('button', { name: /draw/ })).toBeInTheDocument()
    // Kind icon column renders on each row.
    expect(parent.querySelector('svg')).not.toBeNull()
  })

  it('reveals a row through the shared symbol-open path with its range', async () => {
    mocks.getPythonDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /draw/ }))
    expect(mocks.openDefinitionTargetInWorkspace).toHaveBeenCalledTimes(1)
    const [request, target, scope] = mocks.openDefinitionTargetInWorkspace.mock
      .calls[0] as unknown as [
      { filePath: string; relativePath: string; worktreeId: string },
      { uri: string; range: { start: { line: number; character: number } } },
      { id: string }
    ]
    expect(request).toMatchObject({
      filePath: '/ws/repo-1/src/renderer.py',
      relativePath: 'src/renderer.py',
      worktreeId: 'repo-1::/ws/repo-1'
    })
    expect(target).toMatchObject({
      uri: 'file:///ws/repo-1/src/renderer.py',
      range: { start: { line: 10, character: 7 } }
    })
    expect(scope.id).toBe('local:worktree:repo-1:python')
  })

  it('switches content when the active editor tab changes', async () => {
    mocks.getPythonDocumentSymbols.mockResolvedValue(treeSymbols)
    const other = [
      {
        name: 'solo',
        kind: 12,
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 8 } },
        selectionRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } }
      }
    ]
    renderPanel()
    await screen.findByRole('button', { name: /Renderer/ })

    useAppStore.setState({
      activeFileId: 'f2',
      openFiles: [
        openFileFixture({
          id: 'f2',
          filePath: '/ws/repo-1/src/other.py',
          relativePath: 'src/other.py',
          language: 'python'
        })
      ],
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture()] }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    mocks.getPythonDocumentSymbols.mockResolvedValueOnce(other)

    expect(await screen.findByRole('button', { name: /solo/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Renderer/ })).not.toBeInTheDocument()
    expect(screen.getByText('other.py')).toBeInTheDocument()
  })

  it.each([
    ['renderer.cpp', 'cpp'],
    ['header.h', 'c']
  ])(
    'renders the %s symbol tree through the C++ document-symbol query (#100)',
    async (fileName, language) => {
      setState({
        openFiles: [
          openFileFixture({
            id: 'f1',
            filePath: `/ws/repo-1/src/${fileName}`,
            relativePath: `src/${fileName}`,
            language
          })
        ],
        settings: {
          codeIntelligenceScopes: [scopeFixture({ language: 'cpp' })]
        }
      })
      mocks.getCppDocumentSymbols.mockResolvedValue([
        {
          name: 'Renderer',
          kind: 23, // Struct
          range: { start: { line: 0, character: 6 }, end: { line: 40, character: 0 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
          children: [
            {
              name: 'draw',
              kind: 6,
              range: { start: { line: 10, character: 4 }, end: { line: 12, character: 9 } },
              selectionRange: {
                start: { line: 10, character: 7 },
                end: { line: 10, character: 11 }
              }
            }
          ]
        }
      ])
      renderPanel()
      expect(await screen.findByRole('button', { name: /Renderer/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /draw/ })).toBeInTheDocument()
      expect(screen.getByText(fileName)).toBeInTheDocument()
      expect(mocks.getPythonDocumentSymbols).not.toHaveBeenCalled()
    }
  )

  it('shows the static no-symbols state for unsupported file types without querying', async () => {
    setState({
      openFiles: [
        openFileFixture({
          id: 'f1',
          filePath: '/ws/repo-1/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript'
        })
      ],
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture()] }
    })
    renderPanel()
    expect(await screen.findByText('No symbols for this file type')).toBeInTheDocument()
    expect(mocks.getPythonDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows an unavailable state when no scope covers the file', async () => {
    setState({
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [] }
    })
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(mocks.getPythonDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows an unavailable state when the covering scope lacks fresh consent', async () => {
    setState({
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture({ consent: undefined })] }
    })
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(mocks.getPythonDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows an open-a-file state when no editor tab is active', async () => {
    setState({ activeFileId: null, activeTabType: 'terminal' })
    renderPanel()
    expect(await screen.findByText('Open a file to see its symbols')).toBeInTheDocument()
    expect(mocks.getPythonDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows a loading state while the query is in flight', async () => {
    const gate: { release: ((symbols: unknown) => void) | null } = { release: null }
    mocks.getPythonDocumentSymbols.mockReturnValue(
      new Promise<unknown>((resolve) => {
        gate.release = resolve
      })
    )
    renderPanel()
    expect(await screen.findByText('Reading symbols…')).toBeInTheDocument()
    gate.release?.(treeSymbols)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Renderer/ })).toBeInTheDocument()
    )
  })
})
