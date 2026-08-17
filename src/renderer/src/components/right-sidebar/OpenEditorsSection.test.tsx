// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { useAppStore } from '@/store'
import { OpenEditorsSection, reorderOpenFilesOnDragEnd } from './OpenEditorsSection'
import type { DragEndEvent } from '@dnd-kit/core'

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
      activeFileIdByWorktree: {},
      closeFile: vi.fn(),
      setActiveFile: vi.fn()
    } as unknown as ReturnType<typeof useAppStore.getState>)
  })

  it('renders nothing when no open files for the active worktree', () => {
    const { container } = render(<OpenEditorsSection />)
    expect(container.firstChild).toBeNull()
  })

  it('lists open files and closes on × click', () => {
    useAppStore.setState({
      openFiles: [
        { id: 'a', filePath: '/w/a.ts', relativePath: 'a.ts', worktreeId: 'w', language: 'typescript', isDirty: false },
        { id: 'b', filePath: '/w/b.ts', relativePath: 'b.ts', worktreeId: 'w', language: 'typescript', isDirty: true }
      ]
    } as unknown as ReturnType<typeof useAppStore.getState>)
    render(<OpenEditorsSection />)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0])
    expect(useAppStore.getState().closeFile).toHaveBeenCalledWith('a')
  })

  // Why: dnd-kit's DndContext renders only context providers (no DOM node, no
  // onDragEnd on any element), so firing a real DragEnd in jsdom isn't possible.
  // The handler is exported as the test seam (brief permits this); rendering the
  // section exercises the DndContext+SortableContext+useSortable wiring, then the
  // exported handler is invoked with the same ctx the component would build.
  it('reorders on drag end via reorderOpenFiles', () => {
    useAppStore.setState({
      openFiles: [
        { id: 'a', filePath: '/w/a', relativePath: 'a', worktreeId: 'w', language: 'text', isDirty: false },
        { id: 'b', filePath: '/w/b', relativePath: 'b', worktreeId: 'w', language: 'text', isDirty: false }
      ],
      reorderOpenFiles: vi.fn()
    } as unknown as ReturnType<typeof useAppStore.getState>)
    render(<OpenEditorsSection />)
    const event = { active: { id: 'a' }, over: { id: 'b' } } as unknown as DragEndEvent
    reorderOpenFilesOnDragEnd(event, {
      worktreeId: 'w',
      ids: ['a', 'b'],
      reorder: useAppStore.getState().reorderOpenFiles
    })
    expect(useAppStore.getState().reorderOpenFiles).toHaveBeenCalledWith('w', 0, 1)
  })
})
