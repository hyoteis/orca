// @vitest-environment happy-dom

import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SymbolSearchResults } from './SymbolSearchResults'
import type { SymbolRow } from './symbol-search-rows'

afterEach(cleanup)

const row = (name: string, overrides: Partial<SymbolRow> = {}): SymbolRow => ({
  key: `k:${name}`,
  name,
  containerName: '',
  kindLabel: 'Function',
  scopeId: 's1',
  scopeName: 'Python',
  uri: `file:///repo/${name}.py`,
  displayPath: `${name}.py`,
  external: false,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  ...overrides
})

describe('SymbolSearchResults', () => {
  it('renders rows with kind label and opens on click', () => {
    const onOpen = vi.fn()
    render(
      <SymbolSearchResults
        query="mai"
        rows={[row('main')]}
        loading={false}
        partial={false}
        onOpen={onOpen}
        onFallbackToText={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /main/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'main' }))
    expect(screen.getByText(/1 symbol/)).toBeTruthy()
    expect(screen.queryByText(/partial/i)).toBeNull()
  })

  it('shows the Partial label after a rejected fan-out', () => {
    render(
      <SymbolSearchResults
        query="x"
        rows={[row('a'), row('b')]}
        loading={false}
        partial
        onOpen={vi.fn()}
        onFallbackToText={vi.fn()}
      />
    )

    expect(screen.getByText(/partial/i)).toBeTruthy()
    expect(screen.getByText(/2 symbols/)).toBeTruthy()
  })

  it('offers the labelled text-search fallback when symbols come back empty', () => {
    const onFallbackToText = vi.fn()
    render(
      <SymbolSearchResults
        query="needle"
        rows={[]}
        loading={false}
        partial={false}
        onOpen={vi.fn()}
        onFallbackToText={onFallbackToText}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /search text instead/i }))
    expect(onFallbackToText).toHaveBeenCalledTimes(1)
  })

  it('labels out-of-root symbols as external dependencies', () => {
    render(
      <SymbolSearchResults
        query="x"
        rows={[row('site', { external: true, displayPath: '/site-packages/site.py' })]}
        loading={false}
        partial={false}
        onOpen={vi.fn()}
        onFallbackToText={vi.fn()}
      />
    )

    expect(screen.getByText(/external dependency/i)).toBeTruthy()
  })

  it('renders a range-less row disabled with the unresolved hint', () => {
    render(
      <SymbolSearchResults
        query="x"
        rows={[row('lazy', { range: null })]}
        loading={false}
        partial={false}
        onOpen={vi.fn()}
        onFallbackToText={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /lazy/ })).toHaveProperty('disabled', true)
    expect(screen.getByTitle(/symbol location unresolved/i)).toBeTruthy()
  })

  it('keeps the summary header visible with the Partial label when every scope failed', () => {
    render(
      <SymbolSearchResults
        query="x"
        rows={[]}
        loading={false}
        partial
        onOpen={vi.fn()}
        onFallbackToText={vi.fn()}
      />
    )

    expect(screen.getByText(/^partial$/i)).toBeTruthy()
    expect(screen.getByText(/some scopes failed to answer/i)).toBeTruthy()
  })

  it('prompts to type when the query is empty', () => {
    render(
      <SymbolSearchResults
        query=""
        rows={[]}
        loading={false}
        partial={false}
        onOpen={vi.fn()}
        onFallbackToText={vi.fn()}
      />
    )

    expect(screen.getByText(/type to search workspace symbols/i)).toBeTruthy()
  })
})
