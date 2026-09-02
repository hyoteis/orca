// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { useAppStore } from '@/store'
import { OpenEditorsSection, reorderOpenEditorsOnDragEnd } from './OpenEditorsSection'
import type { DragEndEvent } from '@dnd-kit/core'
import { TooltipProvider } from '@/components/ui/tooltip'

function renderSection(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <OpenEditorsSection />
    </TooltipProvider>
  )
}

function openFileFixture(id: string, filePath: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filePath,
    relativePath: filePath.replace(/^\/w\//, ''),
    worktreeId: 'w',
    language: 'text',
    isDirty: false,
    mode: 'edit',
    ...extra
  }
}

function editorTabFixture(fileId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `tab-${fileId}`,
    entityId: fileId,
    contentType: 'editor',
    groupId: 'g',
    title: fileId,
    isPreview: false,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra
  }
}

describe('OpenEditorsSection', () => {
  afterEach(() => {
    // No `globals: true`, so Testing Library's auto-cleanup never runs.
    cleanup()
    vi.clearAllMocks()
  })

  beforeEach(() => {
    useAppStore.setState({
      activeWorktreeId: 'w',
      openFiles: [],
      gitStatusByWorktree: {},
      activeFileIdByWorktree: {},
      unifiedTabsByWorktree: {},
      closeFile: vi.fn(),
      setActiveFile: vi.fn(),
      reorderFiles: vi.fn(),
      pinFile: vi.fn(),
      unpinTab: vi.fn()
    } as unknown as ReturnType<typeof useAppStore.getState>)
  })

  it('renders nothing when no open files for the active worktree', () => {
    const { container } = renderSection()
    expect(container.firstChild).toBeNull()
  })

  it('lists open files and closes on × click', () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('a', '/w/a.ts'),
        openFileFixture('b', '/w/b.ts', { isDirty: true })
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0])
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('a')
  })

  it('shows one row per path: an edit tab and its diff collapse to a single row', () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('edit', '/w/src/changed.ts'),
        openFileFixture('diff', '/w/src/changed.ts', { mode: 'diff', diffSource: 'unstaged' })
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    expect(screen.getAllByText('changed.ts')).toHaveLength(1)
  })

  it('prefers the edit-mode entry when collapsing same-path rows', () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('diff', '/w/src/changed.ts', { mode: 'diff', diffSource: 'unstaged' }),
        openFileFixture('edit', '/w/src/changed.ts')
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    expect(screen.getByText('changed.ts').parentElement).not.toHaveTextContent('(diff)')
  })

  it('× on a collapsed same-path row closes every editor of that path', () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('edit', '/w/src/changed.ts'),
        openFileFixture('diff', '/w/src/changed.ts', { mode: 'diff', diffSource: 'unstaged' })
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0])
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('edit')
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('diff')
  })

  it('marks uncommitted open files with a diff suffix', () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('changed', '/w/src/changed.ts'),
        openFileFixture('branch', '/w/src/committed.ts', { mode: 'diff', diffSource: 'branch' })
      ],
      gitStatusByWorktree: {
        w: [{ path: 'src/changed.ts', area: 'unstaged', status: 'modified' }]
      }
    } as unknown as ReturnType<typeof useAppStore.getState>)

    renderSection()

    expect(screen.getByText('changed.ts').parentElement).toHaveTextContent('changed.ts (diff)')
    expect(screen.getByText('committed.ts').parentElement).not.toHaveTextContent('(diff)')
  })

  it('shows only the file name while keeping the relative path in a hover tooltip', async () => {
    useAppStore.setState({
      openFiles: [openFileFixture('nested', '/w/src/components/Button.tsx')]
    } as unknown as ReturnType<typeof useAppStore.getState>)

    renderSection()

    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.queryByText('src/components/Button.tsx')).not.toBeInTheDocument()
    fireEvent.pointerMove(screen.getByText('Button.tsx'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('src/components/Button.tsx')
  })

  it('collapses and expands via the section header', () => {
    useAppStore.setState({
      openFiles: [openFileFixture('a', '/w/a.ts')]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    const header = screen.getByRole('button', { name: /open editors/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(header)
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('renders pinned editors first with a pin marker', () => {
    useAppStore.setState({
      openFiles: [openFileFixture('a', '/w/a.ts'), openFileFixture('b', '/w/b.ts')],
      unifiedTabsByWorktree: { w: [editorTabFixture('b', { isPinned: true })] }
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    const rows = screen.getAllByText(/^[ab]\.ts$/)
    expect(rows[0]).toHaveTextContent('b.ts')
    expect(rows[0].closest('[data-open-editor-row]')).toHaveAttribute('data-pinned', 'true')
    expect(rows[1].closest('[data-open-editor-row]')).toHaveAttribute('data-pinned', 'false')
  })

  it('pins via the row context menu', async () => {
    useAppStore.setState({
      openFiles: [openFileFixture('a', '/w/a.ts')],
      unifiedTabsByWorktree: { w: [editorTabFixture('a')] }
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    fireEvent.contextMenu(screen.getByText('a.ts'))
    fireEvent.click(await screen.findByText('Pin'))
    expect(useAppStore.getState().pinFile).toHaveBeenCalledWith('a', 'tab-a')
  })

  it('unpins via the row context menu', async () => {
    useAppStore.setState({
      openFiles: [openFileFixture('a', '/w/a.ts')],
      unifiedTabsByWorktree: { w: [editorTabFixture('a', { isPinned: true })] }
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    fireEvent.contextMenu(screen.getByText('a.ts'))
    fireEvent.click(await screen.findByText('Unpin'))
    expect(useAppStore.getState().unpinTab).toHaveBeenCalledWith('tab-a')
  })

  it('closes all same-path editors from the row context menu', async () => {
    useAppStore.setState({
      openFiles: [
        openFileFixture('edit', '/w/src/changed.ts'),
        openFileFixture('diff', '/w/src/changed.ts', { mode: 'diff', diffSource: 'unstaged' })
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    fireEvent.contextMenu(screen.getByText('changed.ts'))
    fireEvent.click(await screen.findByText('Close'))
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('edit')
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('diff')
  })

  // Why: dnd-kit's DndContext renders only context providers (no DOM node), so
  // a real DragEnd can't be fired in happy-dom; the exported handler is the seam.
  it('writes the next projected order back via reorderFiles on drag end', () => {
    useAppStore.setState({
      openFiles: [openFileFixture('a', '/w/a.ts'), openFileFixture('b', '/w/b.ts')],
      reorderFiles: vi.fn()
    } as unknown as ReturnType<typeof useAppStore.getState>)
    renderSection()
    const event = { active: { id: 'a' }, over: { id: 'b' } } as unknown as DragEndEvent
    reorderOpenEditorsOnDragEnd(event, {
      ids: ['a', 'b'],
      reorder: useAppStore.getState().reorderFiles
    })
    expect(useAppStore.getState().reorderFiles).toHaveBeenCalledWith(['b', 'a'])
  })

  it('ignores drag end without a target or with matching ids', () => {
    const reorder = vi.fn()
    reorderOpenEditorsOnDragEnd({ active: { id: 'a' }, over: null } as unknown as DragEndEvent, {
      ids: ['a', 'b'],
      reorder
    })
    reorderOpenEditorsOnDragEnd(
      { active: { id: 'a' }, over: { id: 'a' } } as unknown as DragEndEvent,
      { ids: ['a', 'b'], reorder }
    )
    expect(reorder).not.toHaveBeenCalled()
  })
})
