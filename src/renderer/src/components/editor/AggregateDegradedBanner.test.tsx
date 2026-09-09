// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { setAggregateMappingHealthForTest } from '@/lib/language-server/use-aggregate-mapping-health'
import { AggregateDegradedBanner } from './AggregateDegradedBanner'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/lib/language-server/cpp-code-intelligence-workspace', () => ({
  CPP_LANGUAGES: new Set(['cpp']),
  findCppCodeIntelligenceScope: vi.fn(() => ({ id: 'scope-1', workspaceRoot: '/ws' }))
}))

const file: OpenFile = {
  id: 'f1',
  filePath: '/ws/main.cpp',
  relativePath: 'main.cpp',
  worktreeId: 'ws::/ws',
  language: 'cpp',
  isDirty: false,
  mode: 'edit'
} as unknown as OpenFile

function setState(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    activeWorktreeId: 'ws::/ws',
    settings: { codeIntelligenceScopes: [] },
    repos: [{ id: 'ws', path: '/ws', connectionId: null }],
    ...overrides
  } as never)
}

const health = (state: 'ok' | 'degraded' | 'warning') => [
  { id: 'm1', memberPath: 'engine', compileDatabase: '/cdb/one.json', state }
]

beforeEach(() => {
  setState()
  setAggregateMappingHealthForTest('scope-1', undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AggregateDegradedBanner (#137 status × surface matrix)', () => {
  it.each([
    ['degraded', true],
    ['warning', false],
    ['ok', false]
  ])('banner visibility for mapping state %s', (state, visible) => {
    setAggregateMappingHealthForTest('scope-1', health(state as 'ok' | 'degraded' | 'warning'))
    const { container } = render(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="cpp" />
      </TooltipProvider>
    )
    const banner = container.querySelector('[role="alert"]')
    expect(Boolean(banner)).toBe(visible)
    if (state === 'warning') {
      // Warnings never banner — nothing amber renders at all.
      expect(container.textContent).toBe('')
    }
  })

  it('renders nothing without health data or for non-C++ documents', () => {
    const { container } = render(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="cpp" />
      </TooltipProvider>
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
    cleanup()
    setAggregateMappingHealthForTest('scope-1', health('degraded'))
    render(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="typescript" />
      </TooltipProvider>
    )
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  })

  it('dismisses manually and auto-clears on recovery', () => {
    setAggregateMappingHealthForTest('scope-1', health('degraded'))
    const { rerender } = render(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="cpp" />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    // Recovery clears the dismissal…
    setAggregateMappingHealthForTest('scope-1', health('ok'))
    rerender(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="cpp" />
      </TooltipProvider>
    )
    expect(screen.queryByRole('alert')).toBeNull()
    // …so a later degradation shows again.
    setAggregateMappingHealthForTest('scope-1', health('degraded'))
    rerender(
      <TooltipProvider>
        <AggregateDegradedBanner file={file} language="cpp" />
      </TooltipProvider>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
