// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as WorkspaceModule from '@/lib/language-server/code-intelligence-workspace'
import type * as SemanticDocumentsModule from '@/lib/language-server/semantic-monaco-documents'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { OutlinePanel } from './OutlinePanel'

const mocks = vi.hoisted(() => ({
  getCppDocumentSymbols: vi.fn(),
  openDefinitionTargetInWorkspace: vi.fn(() => true),
  semanticDocumentEditorFor: vi.fn(),
  upsertScope: vi.fn(),
  grantConsent: vi.fn(),
  fetchSettings: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/language-server/cpp-code-intelligence-requests', () => ({
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
    id: 'local:worktree:repo-1:cpp',
    name: 'repo-1',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/ws/repo-1',
    language: 'cpp',
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
        filePath: '/ws/repo-1/src/renderer.cpp',
        relativePath: 'src/renderer.cpp',
        language: 'cpp'
      })
    ],
    repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
    settings: { codeIntelligenceScopes: [scopeFixture()] },
    ...overrides
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
}

/** Live document stand-in (#102): captures the cursor/content listeners the
 * panel subscribes to, with mutable text for the debounce test. */
function createDocumentHarness() {
  const harness = {
    text: 'struct Renderer {',
    cursorListeners: [] as ((event: { position: { lineNumber: number } }) => void)[],
    contentListeners: [] as (() => void)[],
    editor: {} as Record<string, unknown>,
    model: {} as Record<string, unknown>
  }
  harness.editor = {
    getPosition: () => null,
    onDidChangeCursorPosition: (
      listener: (event: { position: { lineNumber: number } }) => void
    ) => {
      harness.cursorListeners.push(listener)
      return { dispose: () => undefined }
    }
  }
  harness.model = {
    getValue: () => harness.text,
    getVersionId: () => 7,
    onDidChangeContent: (listener: () => void) => {
      harness.contentListeners.push(listener)
      return { dispose: () => undefined }
    }
  }
  return harness
}

let documentHarness: ReturnType<typeof createDocumentHarness>

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

// Root rows zed/mid/alpha order differently under each sort mode (#102 tests).
const symbolSpan = (startLine: number, endLine: number) => ({
  start: { line: startLine, character: 0 },
  end: { line: endLine, character: 0 }
})
const nameRange = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to }
})

function interactiveSymbols(): unknown[] {
  return [
    {
      name: 'zed',
      kind: 12,
      range: symbolSpan(0, 5),
      selectionRange: nameRange(0, 4, 7)
    },
    {
      name: 'mid',
      kind: 5,
      range: symbolSpan(10, 12),
      selectionRange: nameRange(10, 4, 7)
    },
    {
      name: 'alpha',
      kind: 23,
      range: symbolSpan(20, 30),
      selectionRange: nameRange(20, 6, 11),
      children: [
        {
          name: 'draw',
          kind: 6,
          range: symbolSpan(21, 22),
          selectionRange: nameRange(21, 4, 8)
        },
        {
          name: 'render_pass',
          kind: 6,
          range: symbolSpan(25, 26),
          selectionRange: nameRange(25, 4, 15)
        }
      ]
    }
  ]
}

function renderedRowNames(): string[] {
  return Array.from(document.querySelectorAll('[data-outline-row]')).map(
    (row) => row.getAttribute('data-outline-row') ?? ''
  )
}

function activeRowName(): string | null {
  return (
    document
      .querySelector('[data-active="true"] [data-outline-row]')
      ?.getAttribute('data-outline-row') ?? null
  )
}

beforeEach(() => {
  mocks.getCppDocumentSymbols.mockReset()
  mocks.openDefinitionTargetInWorkspace.mockClear()
  mocks.semanticDocumentEditorFor.mockReset()
  documentHarness = createDocumentHarness()
  mocks.semanticDocumentEditorFor.mockReturnValue(documentHarness)
  mocks.upsertScope.mockReset()
  mocks.upsertScope.mockImplementation(async (scope: CodeIntelligenceScope) => ({
    ...scope,
    revision: 1
  }))
  mocks.grantConsent.mockReset()
  mocks.grantConsent.mockResolvedValue(undefined)
  mocks.fetchSettings.mockClear()
  mocks.fetchSettings.mockResolvedValue(undefined)
  // #101: the Outline may auto-create a scope — shim the IPC surface it uses.
  globalThis.window.api = {
    codeIntelligence: { upsertScope: mocks.upsertScope, grantConsent: mocks.grantConsent }
  } as unknown as typeof window.api
  setState({ fetchSettings: mocks.fetchSettings })
})

afterEach(() => {
  // No `globals: true`, so Testing Library's auto-cleanup never runs.
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
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
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    expect(screen.getByText('Outline')).toBeInTheDocument()
    expect(await screen.findByText('renderer.cpp')).toBeInTheDocument()
  })

  it('renders the nested symbol tree expanded with kind icons and line numbers', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    const parent = await screen.findByRole('button', { name: /Renderer/ })
    expect(parent).toBeInTheDocument()
    // Nested child renders without expanding (default expanded).
    expect(screen.getByRole('button', { name: /draw/ })).toBeInTheDocument()
    // Kind icon column renders on each row.
    expect(parent.querySelector('svg')).not.toBeNull()
  })

  it('reveals a row through the shared symbol-open path with its range', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
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
      filePath: '/ws/repo-1/src/renderer.cpp',
      relativePath: 'src/renderer.cpp',
      worktreeId: 'repo-1::/ws/repo-1'
    })
    expect(target).toMatchObject({
      uri: 'file:///ws/repo-1/src/renderer.cpp',
      range: { start: { line: 10, character: 7 } }
    })
    expect(scope.id).toBe('local:worktree:repo-1:cpp')
  })

  it('switches content when the active editor tab changes', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
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
          filePath: '/ws/repo-1/src/other.cpp',
          relativePath: 'src/other.cpp',
          language: 'cpp'
        })
      ],
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture()] }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    mocks.getCppDocumentSymbols.mockResolvedValueOnce(other)

    expect(await screen.findByRole('button', { name: /solo/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Renderer/ })).not.toBeInTheDocument()
    expect(screen.getByText('other.cpp')).toBeInTheDocument()
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
      expect(mocks.getCppDocumentSymbols).toHaveBeenCalledTimes(1)
      expect(mocks.getCppDocumentSymbols.mock.calls[0]?.[0]).toMatchObject({
        filePath: `/ws/repo-1/src/${fileName}`,
        language
      })
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
    expect(mocks.getCppDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows an unavailable state when the file backs no workspace repo', async () => {
    setState({
      repos: [],
      settings: { codeIntelligenceScopes: [] }
    })
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(mocks.getCppDocumentSymbols).not.toHaveBeenCalled()
    expect(mocks.upsertScope).not.toHaveBeenCalled()
  })

  it('auto-creates the Outline default scope on an uncovered local file (#101)', async () => {
    setState({ settings: { codeIntelligenceScopes: [] } })
    renderPanel()
    await waitFor(() => expect(mocks.upsertScope).toHaveBeenCalledTimes(1))
    const created = mocks.upsertScope.mock.calls[0][0] as CodeIntelligenceScope
    expect(created).toMatchObject({
      id: 'local:worktree:repo-1:cpp',
      origin: 'outline-auto',
      workspaceRoot: '/ws/repo-1',
      members: [{ path: '.', visibleResults: true }],
      serverSource: { type: 'automatic' },
      enabled: true
    })
    // Zero-config = the creation flow grants consent, like the setup dialog.
    expect(mocks.grantConsent).toHaveBeenCalledWith({
      scopeId: created.id,
      revision: 1
    })
    expect(mocks.fetchSettings).toHaveBeenCalled()
    expect(await screen.findByText('Reading symbols…')).toBeInTheDocument()
  })

  it('shows the enable affordance instead of resurrecting a deleted auto scope', async () => {
    setState({
      settings: {
        codeIntelligenceScopes: [],
        codeIntelligenceDeclinedAutoScopes: ['local:worktree:repo-1:cpp']
      }
    })
    renderPanel()
    expect(await screen.findByText('Enable code intelligence')).toBeInTheDocument()
    expect(mocks.upsertScope).not.toHaveBeenCalled()
  })

  it('shows the enable affordance on SSH-host repos without auto-creating', async () => {
    setState({
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: 'box' }],
      settings: { codeIntelligenceScopes: [] }
    })
    renderPanel()
    expect(await screen.findByText('Enable code intelligence to see symbols')).toBeInTheDocument()
    expect(mocks.upsertScope).not.toHaveBeenCalled()
  })

  it('routes the enable button to the Code scopes dialog with a python preselect (#106)', async () => {
    const openModal = vi.fn()
    setState({
      openModal,
      settings: {
        codeIntelligenceScopes: [],
        codeIntelligenceDeclinedAutoScopes: ['local:worktree:repo-1:cpp']
      }
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Enable code intelligence' }))
    expect(openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1',
      language: 'cpp'
    })
  })

  it('preselects cpp when the enable button serves a C++ file (#106)', async () => {
    const openModal = vi.fn()
    setState({
      openModal,
      openFiles: [
        openFileFixture({
          id: 'f1',
          filePath: '/ws/repo-1/src/renderer.cpp',
          relativePath: 'src/renderer.cpp',
          language: 'cpp'
        })
      ],
      settings: {
        codeIntelligenceScopes: [],
        codeIntelligenceDeclinedAutoScopes: ['local:worktree:repo-1:cpp']
      }
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Enable code intelligence' }))
    expect(openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1',
      language: 'cpp'
    })
  })

  it('shows an unavailable state when the covering scope lacks fresh consent', async () => {
    setState({
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture({ consent: undefined })] }
    })
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(mocks.getCppDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows an open-a-file state when no editor tab is active', async () => {
    setState({ activeFileId: null, activeTabType: 'terminal' })
    renderPanel()
    expect(await screen.findByText('Open a file to see its symbols')).toBeInTheDocument()
    expect(mocks.getCppDocumentSymbols).not.toHaveBeenCalled()
  })

  it('shows a loading state while the query is in flight', async () => {
    const gate: { release: ((symbols: unknown) => void) | null } = { release: null }
    mocks.getCppDocumentSymbols.mockReturnValue(
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

  it('shows the server-error state with a retry that re-queries (#102)', async () => {
    mocks.getCppDocumentSymbols.mockRejectedValueOnce(new Error('server exited'))
    renderPanel()
    expect(await screen.findByText('Language server connection failed')).toBeInTheDocument()
    // The rejection message replaces the generic subtitle — it names the remedy.
    expect(screen.getByText('server exited')).toBeInTheDocument()
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Renderer/ })).toBeInTheDocument()
    expect(mocks.getCppDocumentSymbols).toHaveBeenCalledTimes(2)
  })
})

describe('OutlinePanel interactions (#102)', () => {
  function switchToFile(id: string, filePath: string): void {
    useAppStore.setState({
      activeFileId: id,
      openFiles: [
        openFileFixture({
          id,
          filePath,
          relativePath: filePath.split('/').pop() ?? filePath,
          language: 'cpp'
        })
      ],
      repos: [{ id: 'repo-1', path: '/ws/repo-1', connectionId: null }],
      settings: { codeIntelligenceScopes: [scopeFixture()] }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
  }

  it('filters rows by name, keeps ancestors expandable, and expands the filter input to its own row', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(interactiveSymbols())
    renderPanel()
    await screen.findByRole('button', { name: /render_pass/ })
    expect(screen.queryByPlaceholderText('Filter symbols')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filter symbols' }))
    const input = screen.getByPlaceholderText('Filter symbols')
    fireEvent.change(input, { target: { value: 'ren' } })

    expect(renderedRowNames()).toEqual(['alpha', 'render_pass'])
    expect(document.querySelector('mark')?.textContent).toBe('ren')
    // The retained ancestor stays expandable (its chevron renders as expanded).
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
    // Filtering force-expands: a chevron click neither collapses nor writes memory.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(renderedRowNames()).toEqual(['alpha', 'render_pass'])

    fireEvent.change(input, { target: { value: '' } })
    expect(renderedRowNames()).toEqual(['zed', 'mid', 'alpha', 'draw', 'render_pass'])

    fireEvent.click(screen.getByRole('button', { name: 'Filter symbols' }))
    expect(screen.queryByPlaceholderText('Filter symbols')).not.toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['zed', 'mid', 'alpha', 'draw', 'render_pass'])
  })

  it('sorts position by default and cycles through name and kind modes', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(interactiveSymbols())
    renderPanel()
    await screen.findByRole('button', { name: /alpha/ })
    expect(renderedRowNames()).toEqual(['zed', 'mid', 'alpha', 'draw', 'render_pass'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by name' }))
    expect(renderedRowNames()).toEqual(['alpha', 'draw', 'render_pass', 'mid', 'zed'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by kind' }))
    expect(renderedRowNames()).toEqual(['mid', 'zed', 'alpha', 'draw', 'render_pass'])
  })

  it('highlights the row enclosing the editor cursor and follows moves', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(interactiveSymbols())
    renderPanel()
    await screen.findByRole('button', { name: /render_pass/ })
    const emitCursor = (lineNumber: number): void => {
      act(() => {
        documentHarness.cursorListeners.at(-1)?.({ position: { lineNumber } })
      })
    }

    emitCursor(26)
    expect(activeRowName()).toBe('render_pass')
    emitCursor(1)
    expect(activeRowName()).toBe('zed')
    emitCursor(99)
    expect(activeRowName()).toBeNull()
  })

  it('remembers per-file collapse state across file switches for the session', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(interactiveSymbols())
    // Dedicated paths: the session collapse map is module state, shared across tests.
    switchToFile('f3', '/ws/repo-1/src/collapse.cc')
    renderPanel()
    // alpha is the only row with children → the only chevron.
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse' }))
    expect(screen.queryByRole('button', { name: /render_pass/ })).not.toBeInTheDocument()

    mocks.getCppDocumentSymbols.mockResolvedValueOnce([
      { name: 'solo', kind: 12, range: symbolSpan(0, 3), selectionRange: nameRange(0, 4, 8) }
    ])
    switchToFile('f4', '/ws/repo-1/src/other.cc')
    expect(await screen.findByRole('button', { name: /solo/ })).toBeInTheDocument()

    switchToFile('f3', '/ws/repo-1/src/collapse.cc')
    await screen.findByRole('button', { name: /zed/ })
    expect(screen.queryByRole('button', { name: /render_pass/ })).not.toBeInTheDocument()
  })

  it('refreshes the tree ~500 ms after document edits, not before', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(interactiveSymbols())
    switchToFile('f5', '/ws/repo-1/src/refresh.cc')
    renderPanel()
    await screen.findByRole('button', { name: /render_pass/ })

    vi.useFakeTimers()
    documentHarness.text = 'class Renderer:\n    def render_pass2(self):'
    mocks.getCppDocumentSymbols.mockResolvedValueOnce([
      { name: 'zed', kind: 12, range: symbolSpan(0, 5), selectionRange: nameRange(0, 4, 7) },
      {
        name: 'render_pass2',
        kind: 6,
        range: symbolSpan(10, 20),
        selectionRange: nameRange(10, 4, 16)
      }
    ])
    act(() => {
      documentHarness.contentListeners.at(-1)?.()
    })
    expect(mocks.getCppDocumentSymbols).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(mocks.getCppDocumentSymbols).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(mocks.getCppDocumentSymbols).toHaveBeenCalledTimes(2)
    expect(mocks.getCppDocumentSymbols.mock.calls[1][0]).toMatchObject({
      text: 'class Renderer:\n    def render_pass2(self):'
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /render_pass2/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /alpha/ })).not.toBeInTheDocument()
  })
})

describe('OutlinePanel heuristic tier (#103)', () => {
  const HEURISTIC_TEXT =
    'struct Renderer {\n    void draw();\n};\n\nint main() { return 0; }\n'
  const setDeclinedScope = (): void =>
    setState({
      settings: {
        codeIntelligenceScopes: [],
        codeIntelligenceDeclinedAutoScopes: ['local:worktree:repo-1:cpp']
      }
    })

  it('renders heuristic rows with the approximate badge and the enable action', async () => {
    setDeclinedScope()
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByRole('button', { name: /Renderer/ })).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    // Flat line-level rows: no chevrons anywhere.
    expect(screen.queryByRole('button', { name: 'Collapse' })).not.toBeInTheDocument()
    const badge = screen.getByTestId('outline-approximate-badge')
    expect(badge).toHaveTextContent('Approximate')
    expect(badge).toHaveAttribute(
      'aria-label',
      'No language server connected — symbols are approximate and jumps are line-level'
    )
    expect(screen.getByRole('button', { name: 'Enable code intelligence' })).toBeInTheDocument()
    // While filtering, the no-match/match state stands alone — the tier footer
    // must not stack a second status visual under it (review finding).
    fireEvent.click(screen.getByRole('button', { name: 'Filter symbols' }))
    fireEvent.change(screen.getByPlaceholderText('Filter symbols'), {
      target: { value: 'zzz-no-match' }
    })
    expect(screen.getByText('No matching symbols')).toBeInTheDocument()
    expect(screen.queryByTestId('outline-status-footer')).not.toBeInTheDocument()
  })

  it('reveals a heuristic row by line through the pending-editor-reveal path', async () => {
    const setPendingEditorReveal = vi.fn()
    setState({
      setPendingEditorReveal,
      settings: {
        codeIntelligenceScopes: [],
        codeIntelligenceDeclinedAutoScopes: ['local:worktree:repo-1:cpp']
      }
    })
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    expect(setPendingEditorReveal).toHaveBeenCalledWith({
      filePath: '/ws/repo-1/src/renderer.cpp',
      line: 5,
      column: 5,
      matchLength: 0
    })
    expect(mocks.openDefinitionTargetInWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a semantic-ready outline free of the approximate badge', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValue(treeSymbols)
    renderPanel()
    await screen.findByRole('button', { name: /Renderer/ })
    expect(screen.queryByTestId('outline-approximate-badge')).not.toBeInTheDocument()
  })

  it('falls back to heuristic rows plus retry when the semantic query fails', async () => {
    mocks.getCppDocumentSymbols.mockRejectedValueOnce(new Error('server exited'))
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByText('Language server connection failed')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('keeps the approximate badge when heuristic extraction finds nothing (tier, not rows)', async () => {
    setDeclinedScope()
    documentHarness.text = 'pass\n'
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual([])
  })

  it('renders the error state with heuristic rows and retry when the session dropped (query resolves null, #107)', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValueOnce(null)
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByText('Language server connection failed')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No symbols in this file')).not.toBeInTheDocument()
  })

  it('renders the error state for a dropped C++ session too (#107)', async () => {
    setState({
      openFiles: [
        openFileFixture({
          id: 'f1',
          filePath: '/ws/repo-1/src/renderer.cpp',
          relativePath: 'src/renderer.cpp',
          language: 'cpp'
        })
      ],
      settings: { codeIntelligenceScopes: [scopeFixture({ language: 'cpp' })] }
    })
    mocks.getCppDocumentSymbols.mockResolvedValueOnce(null)
    renderPanel()
    expect(await screen.findByText('Language server connection failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('keeps the empty-file state when the query resolves a real empty array (#107)', async () => {
    mocks.getCppDocumentSymbols.mockResolvedValueOnce([])
    renderPanel()
    expect(await screen.findByText('No symbols in this file')).toBeInTheDocument()
    expect(screen.queryByText('Language server connection failed')).not.toBeInTheDocument()
  })

  it('shows heuristic rows under the plain no-scope message', async () => {
    setState({ repos: [], settings: { codeIntelligenceScopes: [] } })
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    expect(mocks.upsertScope).not.toHaveBeenCalled()
  })
})
