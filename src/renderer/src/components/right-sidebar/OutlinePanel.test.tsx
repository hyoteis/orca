// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as SemanticDocumentsModule from '@/components/editor/semantic-monaco-documents'
import {
  resetLanguageServerStatusForTests,
  setLanguageServerIndexing
} from '@/components/editor/lsp-navigation/language-server-status-store'
import type {
  LanguageServerDocumentSymbolNode,
  LanguageServerDocumentSymbolPayload,
  LanguageServerDocumentSymbolResult,
  LanguageServerSymbolKind,
  LanguageServerSymbolRange
} from '../../../../shared/language-server-navigation-types'
import { OutlinePanel } from './OutlinePanel'
import { resetOutlineDocumentSymbolCacheForTests } from './use-outline-symbols'

const mocks = vi.hoisted(() => ({
  documentSymbol: vi.fn(),
  semanticDocumentEditorFor: vi.fn(),
  setPendingEditorReveal: vi.fn()
}))

vi.mock('@/components/editor/semantic-monaco-documents', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticDocumentsModule>()
  return {
    ...actual,
    semanticDocumentEditorFor: mocks.semanticDocumentEditorFor
  }
})

const SESSION_KEY = 'local-worktree:repo-1'

function okResult(
  symbols: LanguageServerDocumentSymbolPayload,
  sessionKey = SESSION_KEY
): LanguageServerDocumentSymbolResult {
  return { ok: true, symbols, sessionKey }
}

function failureResult(error: string): LanguageServerDocumentSymbolResult {
  return { ok: false, error, symbols: null, sessionKey: null }
}

const emptyPayload: LanguageServerDocumentSymbolPayload = { kind: 'hierarchical', roots: [] }

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

type AppStatePatch = Partial<ReturnType<typeof useAppStore.getState>>

function setState(overrides: AppStatePatch = {}): void {
  useAppStore.setState({
    activeWorktreeId: 'repo-1::/ws/repo-1',
    activeFileIdByWorktree: { 'repo-1::/ws/repo-1': 'f1' },
    openFiles: [
      openFileFixture({
        id: 'f1',
        filePath: '/ws/repo-1/src/renderer.cpp',
        relativePath: 'src/renderer.cpp',
        language: 'cpp'
      })
    ],
    setPendingEditorReveal: mocks.setPendingEditorReveal,
    ...overrides
  })
}

/** Live document stand-in (#102): captures the cursor/content listeners the
 * panel subscribes to, with mutable text for the debounce test. Firing a
 * content listener bumps the model version first, mirroring Monaco. */
function createDocumentHarness() {
  const cursorListeners: ((event: { position: { lineNumber: number } }) => void)[] = []
  const contentListeners: (() => void)[] = []
  const harness = {
    text: 'struct Renderer {',
    version: 7,
    cursorListeners,
    contentListeners,
    editor: {
      getPosition: (): null => null,
      onDidChangeCursorPosition: (
        listener: (event: { position: { lineNumber: number } }) => void
      ) => {
        harness.cursorListeners.push(listener)
        return { dispose: () => undefined }
      }
    },
    model: {
      getValue: (): string => harness.text,
      getVersionId: (): number => harness.version,
      onDidChangeContent: (listener: () => void) => {
        const wrapped = (): void => {
          harness.version += 1
          listener()
        }
        harness.contentListeners.push(wrapped)
        return { dispose: () => undefined }
      }
    }
  }
  return harness
}

let documentHarness: ReturnType<typeof createDocumentHarness>

// Mirror-shaped symbol fixtures (flat ranges, spec-b B1 wire types).
const symbolSpan = (startLine: number, endLine: number): LanguageServerSymbolRange => ({
  startLine,
  startCharacter: 0,
  endLine,
  endCharacter: 0
})
const nameRange = (line: number, from: number, to: number): LanguageServerSymbolRange => ({
  startLine: line,
  startCharacter: from,
  endLine: line,
  endCharacter: to
})

function node(
  name: string,
  kind: LanguageServerSymbolKind,
  range: LanguageServerSymbolRange,
  selectionRange: LanguageServerSymbolRange,
  children: LanguageServerDocumentSymbolNode[] = []
): LanguageServerDocumentSymbolNode {
  return { name, kind, range, selectionRange, children }
}

const treeSymbols: LanguageServerDocumentSymbolPayload = {
  kind: 'hierarchical',
  roots: [
    node('Renderer', 5, symbolSpan(0, 40), nameRange(0, 6, 14), [
      node('draw', 6, symbolSpan(10, 12), nameRange(10, 7, 11))
    ])
  ]
}

// Root rows zed/mid/alpha order differently under each sort mode (#102 tests).
function interactiveSymbols(): LanguageServerDocumentSymbolPayload {
  return {
    kind: 'hierarchical',
    roots: [
      node('zed', 12, symbolSpan(0, 5), nameRange(0, 4, 7)),
      node('mid', 5, symbolSpan(10, 12), nameRange(10, 4, 7)),
      node('alpha', 23, symbolSpan(20, 30), nameRange(20, 6, 11), [
        node('draw', 6, symbolSpan(21, 22), nameRange(21, 4, 8)),
        node('render_pass', 6, symbolSpan(25, 26), nameRange(25, 4, 15))
      ])
    ]
  }
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
  mocks.documentSymbol.mockReset()
  mocks.semanticDocumentEditorFor.mockReset()
  mocks.setPendingEditorReveal.mockReset()
  documentHarness = createDocumentHarness()
  mocks.semanticDocumentEditorFor.mockReturnValue(documentHarness)
  resetOutlineDocumentSymbolCacheForTests()
  resetLanguageServerStatusForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      languageServers: { documentSymbol: mocks.documentSymbol }
    }
  })
  setState()
})

afterEach(() => {
  // No `globals: true`, so Testing Library's auto-cleanup never runs.
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  resetLanguageServerStatusForTests()
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
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    renderPanel()
    expect(screen.getByText('Outline')).toBeInTheDocument()
    expect(await screen.findByText('renderer.cpp')).toBeInTheDocument()
  })

  it('renders the nested symbol tree expanded with kind icons and line numbers', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    renderPanel()
    const parent = await screen.findByRole('button', { name: /Renderer/ })
    expect(parent).toBeInTheDocument()
    // Nested child renders without expanding (default expanded).
    expect(screen.getByRole('button', { name: /draw/ })).toBeInTheDocument()
    // Kind icon column renders on each row.
    expect(parent.querySelector('svg')).not.toBeNull()
  })

  it('reveals a row through the pending-editor-reveal path with its range', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /draw/ }))
    expect(mocks.setPendingEditorReveal).toHaveBeenCalledTimes(1)
    expect(mocks.setPendingEditorReveal).toHaveBeenCalledWith({
      filePath: '/ws/repo-1/src/renderer.cpp',
      line: 11,
      column: 8,
      matchLength: 0
    })
  })

  it('switches content when the active editor tab changes', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    const other: LanguageServerDocumentSymbolPayload = {
      kind: 'hierarchical',
      roots: [node('solo', 12, symbolSpan(3, 3), nameRange(3, 4, 8))]
    }
    renderPanel()
    await screen.findByRole('button', { name: /Renderer/ })

    setState({
      activeFileIdByWorktree: { 'repo-1::/ws/repo-1': 'f2' },
      openFiles: [
        openFileFixture({
          id: 'f2',
          filePath: '/ws/repo-1/src/other.cpp',
          relativePath: 'src/other.cpp',
          language: 'cpp'
        })
      ]
    })
    mocks.documentSymbol.mockResolvedValueOnce(okResult(other))

    expect(await screen.findByRole('button', { name: /solo/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Renderer/ })).not.toBeInTheDocument()
    expect(screen.getByText('other.cpp')).toBeInTheDocument()
  })

  it.each([
    ['renderer.cpp', 'cpp'],
    ['header.h', 'c']
  ])(
    'renders the %s symbol tree through the document-symbol query (#100)',
    async (fileName, language) => {
      setState({
        openFiles: [
          openFileFixture({
            id: 'f1',
            filePath: `/ws/repo-1/src/${fileName}`,
            relativePath: `src/${fileName}`,
            language
          })
        ]
      })
      mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
      renderPanel()
      expect(await screen.findByRole('button', { name: /Renderer/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /draw/ })).toBeInTheDocument()
      expect(screen.getByText(fileName)).toBeInTheDocument()
      expect(mocks.documentSymbol).toHaveBeenCalledTimes(1)
      expect(mocks.documentSymbol.mock.calls[0]?.[0]).toEqual({
        filePath: `/ws/repo-1/src/${fileName}`
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
      ]
    })
    renderPanel()
    expect(await screen.findByText('No symbols for this file type')).toBeInTheDocument()
    expect(mocks.documentSymbol).not.toHaveBeenCalled()
  })

  it('shows an open-a-file state when no editor tab is active', async () => {
    setState({ activeFileIdByWorktree: {} })
    renderPanel()
    expect(await screen.findByText('Open a file to see its symbols')).toBeInTheDocument()
    expect(mocks.documentSymbol).not.toHaveBeenCalled()
  })

  it('shows a loading state while the query is in flight', async () => {
    const gate: { release: ((result: LanguageServerDocumentSymbolResult) => void) | null } = {
      release: null
    }
    mocks.documentSymbol.mockReturnValue(
      new Promise<LanguageServerDocumentSymbolResult>((resolve) => {
        gate.release = resolve
      })
    )
    renderPanel()
    expect(await screen.findByText('Reading symbols…')).toBeInTheDocument()
    gate.release?.(okResult(treeSymbols))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Renderer/ })).toBeInTheDocument()
    )
  })

  it('shows the unready state with the failure message and a retry that re-queries', async () => {
    mocks.documentSymbol.mockRejectedValueOnce(new Error('server exited'))
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    // The failure message replaces the generic subtitle — it names the remedy.
    expect(screen.getByText('server exited')).toBeInTheDocument()
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Renderer/ })).toBeInTheDocument()
    expect(mocks.documentSymbol).toHaveBeenCalledTimes(2)
  })
})

describe('OutlinePanel interactions (#102)', () => {
  function switchToFile(id: string, filePath: string): void {
    setState({
      activeFileIdByWorktree: { 'repo-1::/ws/repo-1': id },
      openFiles: [
        openFileFixture({
          id,
          filePath,
          relativePath: filePath.split('/').pop() ?? filePath,
          language: 'cpp'
        })
      ]
    })
  }

  it('filters rows by name, keeps ancestors expandable, and expands the filter input to its own row', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(interactiveSymbols()))
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
    mocks.documentSymbol.mockResolvedValue(okResult(interactiveSymbols()))
    renderPanel()
    await screen.findByRole('button', { name: /alpha/ })
    expect(renderedRowNames()).toEqual(['zed', 'mid', 'alpha', 'draw', 'render_pass'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by name' }))
    expect(renderedRowNames()).toEqual(['alpha', 'draw', 'render_pass', 'mid', 'zed'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by kind' }))
    expect(renderedRowNames()).toEqual(['mid', 'zed', 'alpha', 'draw', 'render_pass'])
  })

  it('highlights the row enclosing the editor cursor and follows moves', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(interactiveSymbols()))
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
    mocks.documentSymbol.mockResolvedValue(okResult(interactiveSymbols()))
    // Dedicated paths: the session collapse map is module state, shared across tests.
    switchToFile('f3', '/ws/repo-1/src/collapse.cc')
    renderPanel()
    // alpha is the only row with children → the only chevron.
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse' }))
    expect(screen.queryByRole('button', { name: /render_pass/ })).not.toBeInTheDocument()

    const solo: LanguageServerDocumentSymbolPayload = {
      kind: 'hierarchical',
      roots: [node('solo', 12, symbolSpan(0, 3), nameRange(0, 4, 8))]
    }
    mocks.documentSymbol.mockResolvedValueOnce(okResult(solo))
    switchToFile('f4', '/ws/repo-1/src/other.cc')
    expect(await screen.findByRole('button', { name: /solo/ })).toBeInTheDocument()

    switchToFile('f3', '/ws/repo-1/src/collapse.cc')
    await screen.findByRole('button', { name: /zed/ })
    expect(screen.queryByRole('button', { name: /render_pass/ })).not.toBeInTheDocument()
  })

  it('refreshes the tree ~500 ms after document edits, not before', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(interactiveSymbols()))
    switchToFile('f5', '/ws/repo-1/src/refresh.cc')
    renderPanel()
    await screen.findByRole('button', { name: /render_pass/ })

    vi.useFakeTimers()
    documentHarness.text = 'struct Updated { int render_pass2; };'
    const refreshed: LanguageServerDocumentSymbolPayload = {
      kind: 'hierarchical',
      roots: [
        node('zed', 12, symbolSpan(0, 5), nameRange(0, 4, 7)),
        node('render_pass2', 6, symbolSpan(10, 20), nameRange(10, 4, 16))
      ]
    }
    mocks.documentSymbol.mockResolvedValueOnce(okResult(refreshed))
    act(() => {
      documentHarness.contentListeners.at(-1)?.()
    })
    expect(mocks.documentSymbol).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(mocks.documentSymbol).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(mocks.documentSymbol).toHaveBeenCalledTimes(2)
    expect(mocks.documentSymbol.mock.calls[1]?.[0]).toEqual({
      filePath: '/ws/repo-1/src/refresh.cc'
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /render_pass2/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /alpha/ })).not.toBeInTheDocument()
  })
})

describe('OutlinePanel heuristic tier (#103)', () => {
  const HEURISTIC_TEXT = 'struct Renderer {\n    void draw();\n};\n\nint main() { return 0; }\n'

  it('renders heuristic rows with the approximate badge and the status footer when the query fails', async () => {
    mocks.documentSymbol.mockResolvedValue(failureResult('clangd session unavailable'))
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
    expect(screen.getByTestId('outline-status-footer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
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
    mocks.documentSymbol.mockResolvedValue(failureResult('clangd session unavailable'))
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    expect(mocks.setPendingEditorReveal).toHaveBeenCalledWith({
      filePath: '/ws/repo-1/src/renderer.cpp',
      line: 5,
      column: 5,
      matchLength: 0
    })
  })

  it('keeps a semantic-ready outline free of the approximate badge', async () => {
    mocks.documentSymbol.mockResolvedValue(okResult(treeSymbols))
    renderPanel()
    await screen.findByRole('button', { name: /Renderer/ })
    expect(screen.queryByTestId('outline-approximate-badge')).not.toBeInTheDocument()
  })

  it('falls back to heuristic rows plus retry when the query is rejected', async () => {
    mocks.documentSymbol.mockRejectedValueOnce(new Error('server exited'))
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(screen.getByText('server exited')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('keeps the approximate badge when heuristic extraction finds nothing (tier, not rows)', async () => {
    mocks.documentSymbol.mockResolvedValue(failureResult('clangd session unavailable'))
    documentHarness.text = 'pass\n'
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual([])
  })

  it('renders the unready state with retry when the session dropped (result !ok, #107)', async () => {
    mocks.documentSymbol.mockResolvedValueOnce(
      failureResult('no language-server session owns /ws/repo-1/src/renderer.cpp')
    )
    documentHarness.text = HEURISTIC_TEXT
    renderPanel()
    expect(await screen.findByText('No symbols available')).toBeInTheDocument()
    expect(renderedRowNames()).toEqual(['Renderer', 'draw', 'main'])
    expect(screen.getByTestId('outline-approximate-badge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No symbols in this file')).not.toBeInTheDocument()
  })

  it('keeps the empty-file state when the result carries a real empty payload (#107)', async () => {
    mocks.documentSymbol.mockResolvedValueOnce(okResult(emptyPayload))
    renderPanel()
    expect(await screen.findByText('No symbols in this file')).toBeInTheDocument()
    expect(screen.queryByText('No symbols available')).not.toBeInTheDocument()
  })

  it('shows no badge when the editor is not mounted (plain unready status)', async () => {
    mocks.semanticDocumentEditorFor.mockReturnValue(null)
    mocks.documentSymbol.mockResolvedValue(failureResult('clangd session unavailable'))
    renderPanel()
    // No document → the query never leaves; the panel waits in loading.
    expect(await screen.findByText('Reading symbols…')).toBeInTheDocument()
    expect(screen.queryByTestId('outline-approximate-badge')).not.toBeInTheDocument()
    expect(mocks.documentSymbol).not.toHaveBeenCalled()
  })

  it('explains an empty outline while clangd is indexing instead of showing no symbols (#163)', async () => {
    setLanguageServerIndexing(SESSION_KEY, { active: true, percentage: 45 })
    mocks.documentSymbol.mockResolvedValueOnce(okResult(emptyPayload))
    renderPanel()
    expect(await screen.findByText('clangd is indexing this workspace')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.queryByText('No symbols in this file')).not.toBeInTheDocument()
  })

  it('shows the no-percentage indexing copy while the index has no report yet (#163)', async () => {
    setLanguageServerIndexing(SESSION_KEY, { active: true })
    mocks.documentSymbol.mockResolvedValueOnce(okResult(emptyPayload))
    renderPanel()
    expect(await screen.findByText('clangd is indexing this workspace')).toBeInTheDocument()
    expect(screen.getByText('Symbols appear as the index completes')).toBeInTheDocument()
  })

  it('does not borrow another session\u2019s indexing state', async () => {
    setLanguageServerIndexing('other-session', { active: true, percentage: 90 })
    mocks.documentSymbol.mockResolvedValueOnce(okResult(emptyPayload))
    renderPanel()
    expect(await screen.findByText('No symbols in this file')).toBeInTheDocument()
    expect(screen.queryByText('clangd is indexing this workspace')).not.toBeInTheDocument()
  })
})
