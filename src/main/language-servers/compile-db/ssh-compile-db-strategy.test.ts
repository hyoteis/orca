import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPILE_DB_DEGRADED_HINT, type CompileDbStrategyHooks } from './compile-db-strategy-types'

const getSshFilesystemProvider = vi.fn()

vi.mock('../../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: (...args: unknown[]) => getSshFilesystemProvider(...args)
}))

const { createSshCompileDbStrategy } = await import('./ssh-compile-db-strategy')

type StatCall = { path: string }

/**
 * Fake relay provider: `files` maps exact remote paths to a file stat;
 * anything else throws ENOENT like the remote fs would. Records every stat
 * path so tests can pin the wire form (POSIX separators).
 */
function fakeProvider(files: string[]): {
  provider: { stat: (path: string) => Promise<{ type: 'file' }> }
  calls: StatCall[]
} {
  const calls: StatCall[] = []
  return {
    calls,
    provider: {
      stat: async (path: string) => {
        calls.push({ path })
        if (files.includes(path)) {
          return { type: 'file' }
        }
        throw new Error(`ENOENT: ${path}`)
      }
    }
  }
}

function hooksLog(): { hooks: CompileDbStrategyHooks; degraded: (string | null)[] } {
  const degraded: (string | null)[] = []
  const hooks: CompileDbStrategyHooks = {
    onDegraded: (message) => degraded.push(message)
  }
  return { hooks, degraded }
}

describe('createSshCompileDbStrategy', () => {
  const targetId = 'ssh-target'
  const worktreeRoot = '/home/zwf/graphic_graphic_3d'

  beforeEach(() => {
    getSshFilesystemProvider.mockReset()
  })

  it('detects a root-level compile_commands.json and clears the degraded hint', async () => {
    const { provider, calls } = fakeProvider([`${worktreeRoot}/compile_commands.json`])
    getSshFilesystemProvider.mockReturnValue(provider)
    const { hooks, degraded } = hooksLog()

    const resolution = await createSshCompileDbStrategy(targetId, worktreeRoot, hooks).resolve()

    // Remote paths must be POSIX-joined regardless of host platform (win32
    // `path.join` produces backslashes the remote stat can never match).
    expect(calls.map((c) => c.path)).toEqual([
      `${worktreeRoot}/build/compile_commands.json`,
      `${worktreeRoot}/compile_commands.json`
    ])
    expect(calls.every((c) => !c.path.includes('\\'))).toBe(true)
    expect(resolution).toEqual({ compileCommandsDir: worktreeRoot, degraded: false })
    expect(degraded).toEqual([null])
  })

  it('detects a build-dir compile_commands.json first', async () => {
    const { provider, calls } = fakeProvider([`${worktreeRoot}/build/compile_commands.json`])
    getSshFilesystemProvider.mockReturnValue(provider)
    const { hooks } = hooksLog()

    const resolution = await createSshCompileDbStrategy(targetId, worktreeRoot, hooks).resolve()

    expect(calls).toHaveLength(1)
    expect(resolution).toEqual({ compileCommandsDir: `${worktreeRoot}/build`, degraded: false })
  })

  it('degrades to the single-file hint when no db exists remotely', async () => {
    const { provider } = fakeProvider([])
    getSshFilesystemProvider.mockReturnValue(provider)
    const { hooks, degraded } = hooksLog()

    const resolution = await createSshCompileDbStrategy(targetId, worktreeRoot, hooks).resolve()

    expect(resolution).toEqual({ compileCommandsDir: null, degraded: true })
    expect(degraded).toEqual([COMPILE_DB_DEGRADED_HINT])
  })

  it('degrades without throwing when the transport is lost (no provider)', async () => {
    getSshFilesystemProvider.mockReturnValue(undefined)
    const { hooks, degraded } = hooksLog()

    const resolution = await createSshCompileDbStrategy(targetId, worktreeRoot, hooks).resolve()

    expect(resolution).toEqual({ compileCommandsDir: null, degraded: true })
    expect(degraded).toEqual([COMPILE_DB_DEGRADED_HINT])
  })
})
