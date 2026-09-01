import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { clangdCompileCommandsDirArg } from '../../shared/code-intelligence-cpp-setup'
import type { LanguageServerLaunchRequest } from '../../shared/language-server-session'
import {
  assertClangdCompileCommandsDirExists,
  clangdCompileCommandsDirFromArgs,
  localDirectoryExists
} from './clangd-compile-commands-dir'

function launch(
  overrides: Partial<Pick<LanguageServerLaunchRequest, 'kind' | 'command'>> = {}
): LanguageServerLaunchRequest {
  return {
    sessionId: 's',
    scopeId: 'scope',
    revision: 1,
    kind: 'clangd',
    workspaceRoot: '/workspace',
    executionHostId: 'local' as const,
    members: [],
    ...overrides
  }
}

describe('clangdCompileCommandsDirFromArgs', () => {
  it('reads the dir back from the arg the setup UI persists', () => {
    const arg = clangdCompileCommandsDirArg('/stable/scope-dir')
    expect(clangdCompileCommandsDirFromArgs('clangd', ['--background-index', arg])).toBe(
      '/stable/scope-dir'
    )
  })

  it('ignores non-clangd launches, absent args, and empty values', () => {
    const arg = clangdCompileCommandsDirArg('/cdb')
    expect(clangdCompileCommandsDirFromArgs('basedpyright', [arg])).toBeNull()
    expect(clangdCompileCommandsDirFromArgs('clangd', ['--background-index'])).toBeNull()
    expect(clangdCompileCommandsDirFromArgs('clangd', ['--compile-commands-dir='])).toBeNull()
  })
})

describe('assertClangdCompileCommandsDirExists', () => {
  it('refuses spawn naming the missing directory', async () => {
    const directoryExists = vi.fn(async () => false)
    await expect(
      assertClangdCompileCommandsDirExists(
        launch({ command: { executable: 'clangd', args: [clangdCompileCommandsDirArg('/gone')] } }),
        directoryExists
      )
    ).rejects.toThrow('/gone')
  })

  it('allows spawn when the directory exists', async () => {
    await expect(
      assertClangdCompileCommandsDirExists(
        launch({ command: { executable: 'clangd', args: [clangdCompileCommandsDirArg('/cdb')] } }),
        async () => true
      )
    ).resolves.toBeUndefined()
  })

  it('skips validation for python launches and clangd without the arg', async () => {
    const directoryExists = vi.fn(async () => false)
    await expect(
      assertClangdCompileCommandsDirExists(
        launch({
          kind: 'basedpyright',
          command: { executable: 'basedpyright-langserver', args: ['--stdio'] }
        }),
        directoryExists
      )
    ).resolves.toBeUndefined()
    await expect(
      assertClangdCompileCommandsDirExists(launch(), directoryExists)
    ).resolves.toBeUndefined()
    expect(directoryExists).not.toHaveBeenCalled()
  })
})

describe('localDirectoryExists', () => {
  it('accepts directories and rejects missing paths and plain files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-cdb-'))
    try {
      const file = join(directory, 'compile_commands.json')
      await writeFile(file, '[]')
      await expect(localDirectoryExists(directory)).resolves.toBe(true)
      await expect(localDirectoryExists(file)).resolves.toBe(false)
      await expect(localDirectoryExists(join(directory, 'missing'))).resolves.toBe(false)
    } finally {
      await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true })
    }
  })
})
