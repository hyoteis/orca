import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Store } from '../persistence'
import { CodeIntelligenceCmakeSetup } from './code-intelligence-cmake-setup'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createToolDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-cmake-tools-'))
  tempDirs.push(directory)
  for (const tool of ['clangd', 'cmake', 'ninja']) {
    const path = join(directory, process.platform === 'win32' ? `${tool}.exe` : tool)
    await writeFile(path, '')
    await chmod(path, 0o755)
  }
  return directory
}

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-cmake-workspace-'))
  tempDirs.push(directory)
  await mkdir(join(directory, 'engine'), { recursive: true })
  await writeFile(join(directory, 'CMakeLists.txt'), 'project(root)')
  await writeFile(join(directory, 'engine', 'CMakeLists.txt'), 'project(engine)')
  return directory
}

function fakeStore(workspaceRoot: string, hostId = 'local'): Store {
  return {
    getRepo: (id: string) =>
      id === 'repo-1'
        ? {
            id,
            path: workspaceRoot,
            displayName: 'Engine',
            executionHostId: hostId
          }
        : undefined
  } as unknown as Store
}

describe('CodeIntelligenceCmakeSetup', () => {
  it('configures selected CMake roots and merges their compile databases', async () => {
    const workspace = await createWorkspace()
    const tools = await createToolDirectory()
    const cache = await mkdtemp(join(tmpdir(), 'orca-cmake-cache-'))
    tempDirs.push(cache)
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: `${buildDir}.cpp`, command: 'c++' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCmakeSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: {
        ...process.env,
        PATH: [tools, process.env.PATH ?? ''].join(delimiter),
        INCLUDE: 'test-include',
        LIB: 'test-lib',
        VSCMD_VER: 'test-version'
      },
      run
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['.', 'engine'],
      installMissingTools: true
    })

    expect(result).toMatchObject({ ok: true, relativeRoots: ['.', 'engine'] })
    expect(run).toHaveBeenCalledTimes(2)
    const merged = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(merged).toHaveLength(2)
  })

  it('rejects non-local Hosts before running commands', async () => {
    const workspace = await createWorkspace()
    const run = vi.fn()
    const setup = new CodeIntelligenceCmakeSetup(fakeStore(workspace, 'ssh:host-1'), workspace, {
      run
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['.'],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('local Host')
    expect(run).not.toHaveBeenCalled()
  })
})
