// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorktreeSection } from './WorktreeSection'

function renderSection(
  props: Partial<Parameters<typeof WorktreeSection>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <WorktreeSection collapsed={false} onToggleCollapsed={vi.fn()} {...props}>
      <div data-testid="body" />
    </WorktreeSection>
  )
}

describe('WorktreeSection', () => {
  afterEach(() => {
    // No `globals: true`, so Testing Library's auto-cleanup never runs.
    cleanup()
  })

  it('sheds flex-1 while collapsed so the header hugs the section above', () => {
    const { container } = renderSection({ collapsed: true })
    const section = container.firstElementChild as HTMLElement
    expect(section.className).not.toContain('flex-1')
    expect(section.className).not.toContain('mt-auto')
  })

  it('expands into the remaining panel height and toggles through the header', () => {
    const onToggleCollapsed = vi.fn()
    const { container } = renderSection({ onToggleCollapsed })
    expect((container.firstElementChild as HTMLElement).className).toContain('flex-1')
    fireEvent.click(screen.getByRole('button'))
    expect(onToggleCollapsed).toHaveBeenCalledOnce()
  })

  it('keeps the body mounted but hidden while collapsed', () => {
    renderSection({ collapsed: true })
    expect(screen.getByTestId('body')).toBeInTheDocument()
    expect(screen.getByTestId('body').parentElement).toHaveClass('hidden')
  })
})
