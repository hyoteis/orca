// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { useAppStore } from '@/store'
import { OpenEditorsSection } from './OpenEditorsSection'

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
})
