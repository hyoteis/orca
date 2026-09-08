// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshCompileDatabasePicker } from './SshCompileDatabasePicker'

const mocks = vi.hoisted(() => ({
  browseDir: vi.fn()
}))

beforeEach(() => {
  mocks.browseDir.mockReset()
  globalThis.window.api = {
    ssh: { browseDir: mocks.browseDir }
  } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPicker(props: { onPick?: (path: string) => void } = {}): void {
  render(
    <TooltipProvider>
      <SshCompileDatabasePicker
        targetId="tgt-1"
        initialPath="~"
        onPick={props.onPick ?? (() => {})}
        onCancel={() => {}}
      />
    </TooltipProvider>
  )
}

describe('SshCompileDatabasePicker (#138)', () => {
  it('lists directories and JSON files, hides non-JSON files', async () => {
    mocks.browseDir.mockResolvedValue({
      resolvedPath: '/home/user/build',
      pathFlavor: 'posix',
      entries: [
        { name: 'sub', isDirectory: true },
        { name: 'compile_commands.json', isDirectory: false },
        { name: 'CMakeCache.txt', isDirectory: false }
      ]
    })
    renderPicker()
    await waitFor(() => expect(screen.getByText('compile_commands.json')).toBeInTheDocument())
    expect(screen.getByText('sub')).toBeInTheDocument()
    expect(screen.queryByText('CMakeCache.txt')).not.toBeInTheDocument()
    expect(mocks.browseDir).toHaveBeenCalledWith({ targetId: 'tgt-1', dirPath: '~' })
  })

  it('navigates into a directory and picks a database with its absolute path', async () => {
    mocks.browseDir.mockResolvedValueOnce({
      resolvedPath: '/home/user',
      pathFlavor: 'posix',
      entries: [
        { name: 'build', isDirectory: true },
        { name: 'readme.md', isDirectory: false }
      ]
    })
    mocks.browseDir.mockResolvedValueOnce({
      resolvedPath: '/home/user/build',
      pathFlavor: 'posix',
      entries: [{ name: 'compile_commands.json', isDirectory: false }]
    })
    const onPick = vi.fn()
    renderPicker({ onPick })
    await waitFor(() => expect(screen.getByText('build')).toBeInTheDocument())
    fireEvent.click(screen.getByText('build'))
    await waitFor(() => expect(screen.getByText('compile_commands.json')).toBeInTheDocument())
    expect(mocks.browseDir).toHaveBeenLastCalledWith({ targetId: 'tgt-1', dirPath: '/home/user/build' })
    fireEvent.click(screen.getByText('compile_commands.json'))
    expect(onPick).toHaveBeenCalledWith('/home/user/build/compile_commands.json')
  })

  it('renders the browse failure as a readable error', async () => {
    mocks.browseDir.mockRejectedValue(new Error('SSH Host is not connected. Reconnect and retry.'))
    renderPicker()
    await waitFor(() =>
      expect(screen.getByText('SSH Host is not connected. Reconnect and retry.')).toBeInTheDocument()
    )
  })
})
