// @vitest-environment happy-dom

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeIntelligenceDirectoryPicker } from './CodeIntelligenceDirectoryPicker'

function LazyPicker(): React.JSX.Element {
  const [directories, setDirectories] = useState(['.', 'parent'])
  const [selected, setSelected] = useState(new Set<string>())
  return (
    <CodeIntelligenceDirectoryPicker
      directories={directories}
      selected={selected}
      query=""
      discovering={false}
      onQueryChange={vi.fn()}
      onSelectedChange={(next) => {
        setSelected(next)
        if (next.has('parent')) {
          setDirectories(['.', 'parent', 'parent/child'])
        }
      }}
      onRescan={vi.fn()}
    />
  )
}

describe('CodeIntelligenceDirectoryPicker', () => {
  it('reveals children discovered after selecting a boundary folder', () => {
    render(<LazyPicker />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'parent' }))

    expect(screen.getByText('child')).toBeTruthy()
  })
})
