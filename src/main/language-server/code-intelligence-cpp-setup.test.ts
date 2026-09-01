import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Store } from '../persistence'
import { CodeIntelligenceCppSetup } from './code-intelligence-cpp-setup'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createToolDirectory(
  tools: readonly string[] = ['clangd', 'cmake', 'ninja']
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-cpp-tools-'))
  tempDirs.push(directory)
  for (const tool of tools) {
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

describe('CodeIntelligenceCppSetup', () => {
  it('configures a selected CMake parent once instead of repeating its child', async () => {
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
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
    expect(run).toHaveBeenCalledOnce()
    const merged = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(merged).toHaveLength(1)

    const cached = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['.', 'engine'],
      installMissingTools: true
    })
    expect(cached.message).toContain('Reused cached CMAKE')
    expect(run).toHaveBeenCalledOnce()
  })

  it('configures sibling CMake modules through their common parent project', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-cmake-modules-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-cmake-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(workspace, cache)
    await mkdir(join(workspace, 'DiligentCore'), { recursive: true })
    await mkdir(join(workspace, 'DiligentFX'), { recursive: true })
    await writeFile(join(workspace, 'CMakeLists.txt'), 'add_subdirectory(DiligentCore)')
    await writeFile(join(workspace, 'DiligentCore', 'CMakeLists.txt'), 'project(core)')
    await writeFile(join(workspace, 'DiligentFX', 'CMakeLists.txt'), 'message(FATAL_ERROR)')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const sourceDir = args[args.indexOf('-S') + 1]
      if (sourceDir === join(workspace, 'DiligentFX')) {
        return { code: 1, output: 'DiligentCore module is not found' }
      }
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: 'a.cpp', command: 'c++ a.cpp' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
      relativeRoots: ['DiligentCore', 'DiligentFX'],
      installMissingTools: true
    })

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['-S', workspace]))
  })

  it('uses basic indexing for an arbitrary source folder without build markers', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-source-folder-'))
    const sourceRoot = join(workspace, 'modules', 'renderer')
    const cache = await mkdtemp(join(tmpdir(), 'orca-source-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, cache)
    await mkdir(sourceRoot, { recursive: true })
    await mkdir(join(workspace, 'vendor', 'include'), { recursive: true })
    await writeFile(join(sourceRoot, 'renderer.cpp'), 'int renderer = 1;')
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run: vi.fn()
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['modules/renderer'],
      installMissingTools: true,
      additionalIncludeDirectories: ['vendor/include'],
      defines: ['FEATURE_ENABLED=1'],
      cppStandard: 'c++20'
    })

    expect(result).toMatchObject({
      ok: true,
      message: 'Generated compile commands with BASIC',
      configurationMode: 'basic',
      healthState: 'limited',
      compileCommandCount: 1,
      warnings: [expect.stringContaining('inferred include directories')]
    })
    const database = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(database).toHaveLength(1)
    expect(database[0].arguments).toEqual(
      expect.arrayContaining([
        '-std=c++20',
        '-DFEATURE_ENABLED=1',
        `-I${join(workspace, 'vendor', 'include')}`
      ])
    )
  })

  it('uses basic indexing for a GN component checkout without a dotfile', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-gn-component-'))
    const component = join(workspace, 'lume', 'Lume_3D')
    const cache = await mkdtemp(join(tmpdir(), 'orca-basic-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, cache)
    await mkdir(join(component, 'src'), { recursive: true })
    await mkdir(join(workspace, 'lume', 'LumeBase', 'api', 'base'), { recursive: true })
    await writeFile(join(component, 'BUILD.gn'), 'import("//build/ohos.gni")')
    await writeFile(join(component, 'src', 'engine.cpp'), 'int engine = 1;')
    const run = vi.fn()
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['lume/Lume_3D'],
      installMissingTools: true
    })

    expect(result).toMatchObject({ ok: true, message: 'Generated compile commands with BASIC' })
    expect(result.installedTools).not.toContain('gn')
    expect(run).not.toHaveBeenCalled()
    const database = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(database).toEqual([
      expect.objectContaining({
        file: join(component, 'src', 'engine.cpp'),
        arguments: expect.arrayContaining([
          'clang++',
          '-std=c++17',
          `-I${join(workspace, 'lume', 'LumeBase', 'api')}`
        ])
      })
    ])
  })

  it('generates GN compile commands in the Orca cache and reuses existing args.gn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-gn-workspace-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-gn-cache-'))
    const tools = await createToolDirectory(['clangd', 'gn'])
    tempDirs.push(workspace, cache)
    await writeFile(join(workspace, '.gn'), 'buildconfig = "//build/config/BUILDCONFIG.gn"')
    await writeFile(join(workspace, 'BUILD.gn'), 'group("all") {}')
    await mkdir(join(workspace, 'out', 'Default'), { recursive: true })
    await writeFile(join(workspace, 'out', 'Default', 'args.gn'), 'is_component_build = true')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = join(workspace, args[1])
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: 'main.cc', command: 'clang++ main.cc' }])
      )
      return { code: 0, output: 'Done' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['.'],
      installMissingTools: true
    })

    expect(result).toMatchObject({ ok: true, message: 'Generated compile commands with GN' })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'gen',
        'out/Default',
        `--root=${workspace}`,
        '--export-compile-commands'
      ])
    )
  })

  it('keeps one stable scope directory when members change', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-stable-scope-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-stable-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, cache)
    await mkdir(join(workspace, 'engine', 'src'), { recursive: true })
    await mkdir(join(workspace, 'tools', 'src'), { recursive: true })
    await writeFile(join(workspace, 'engine', 'src', 'engine.cpp'), 'int engine = 1;')
    await writeFile(join(workspace, 'tools', 'src', 'tool.cpp'), 'int tool = 1;')
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run: vi.fn()
    })

    const first = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['engine'],
      installMissingTools: true
    })
    const second = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['engine', 'tools'],
      installMissingTools: true
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.compileCommandsDir).toBe(first.compileCommandsDir)
    expect(second.compileCommandsDir).toMatch(/[/\\]scopes[/\\][0-9a-f]{16}$/)
    expect(JSON.parse(await readFile(join(second.compileCommandsDir!, 'compile_commands.json'), 'utf8'))).toHaveLength(2)
  })

  it('regenerates when the setup manifest fingerprint misses and hits again afterwards', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-manifest-scope-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-manifest-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, cache)
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'main.cpp'), 'int main = 1;')
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run: vi.fn()
    })
    const request = {
      repoId: 'repo-1',
      relativeRoots: ['src'],
      installMissingTools: true
    }

    const initial = await setup.run(request)
    const changed = await setup.run({ ...request, defines: ['FEATURE_ENABLED=1'] })
    const unchanged = await setup.run({ ...request, defines: ['FEATURE_ENABLED=1'] })

    expect(initial.ok).toBe(true)
    expect(changed.message).toContain('Generated compile commands with BASIC')
    expect(
      JSON.parse(await readFile(join(changed.compileCommandsDir!, 'compile_commands.json'), 'utf8'))
    ).toEqual([expect.objectContaining({ arguments: expect.arrayContaining(['-DFEATURE_ENABLED=1']) })])
    expect(unchanged.message).toContain('Reused cached BASIC')
    expect(unchanged.compileCommandsDir).toBe(initial.compileCommandsDir)
  })

  it('leaves the previous merged compile_commands.json intact when regeneration fails', async () => {
    const workspace = await createWorkspace()
    const tools = await createToolDirectory()
    const cache = await mkdtemp(join(tmpdir(), 'orca-atomic-cache-'))
    tempDirs.push(cache)
    let failNextCMake = false
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        failNextCMake ? 'not json' : JSON.stringify([{ directory: buildDir, file: 'a.cpp', command: 'c++' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
    const request = { repoId: 'repo-1', relativeRoots: ['.'], installMissingTools: true }
    const first = await setup.run(request)
    expect(first.ok).toBe(true)
    const mergedPath = join(first.compileCommandsDir!, 'compile_commands.json')

    failNextCMake = true
    await writeFile(join(workspace, 'CMakeLists.txt'), 'project(root-changed)') // bump mtime → fingerprint miss
    const second = await setup.run(request)

    expect(second.ok).toBe(false)
    expect(JSON.parse(await readFile(mergedPath, 'utf8'))).toHaveLength(1)
  })

  it('generates one merged CDB for mixed relative and absolute basic members', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-mixed-relative-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-mixed-absolute-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-mixed-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, outside, cache)
    const absoluteMember = join(outside, 'sdk')
    await mkdir(join(workspace, 'engine'), { recursive: true })
    await mkdir(join(absoluteMember, 'include'), { recursive: true })
    await writeFile(join(workspace, 'engine', 'engine.cpp'), 'int engine = 1;')
    await writeFile(join(absoluteMember, 'include', 'sdk.cpp'), 'int sdk = 1;')
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run: vi.fn()
    })

    const result = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['engine', absoluteMember],
      installMissingTools: true
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'basic',
      healthState: 'limited',
      compileCommandCount: 2
    })
    const merged = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(merged).toEqual([
      expect.objectContaining({ file: join(workspace, 'engine', 'engine.cpp') }),
      expect.objectContaining({ file: join(absoluteMember, 'include', 'sdk.cpp') })
    ])
    expect(merged[1].arguments).toEqual(
      expect.arrayContaining([`-I${join(absoluteMember, 'include')}`])
    )
  })

  it('reports mixed mode and limited health for cmake plus absolute basic members', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-mixed-cmake-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-mixed-basic-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-mixed-cmake-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(workspace, outside, cache)
    const absoluteMember = join(outside, 'tools')
    await mkdir(join(workspace, 'engine'), { recursive: true })
    await mkdir(absoluteMember, { recursive: true })
    await writeFile(join(workspace, 'engine', 'CMakeLists.txt'), 'project(engine)')
    await writeFile(join(absoluteMember, 'tool.cpp'), 'int tool = 1;')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: 'a.cpp', command: 'c++ a.cpp' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
      relativeRoots: ['engine', absoluteMember],
      installMissingTools: true
    })

    expect(result).toMatchObject({
      ok: true,
      configurationMode: 'mixed',
      healthState: 'limited',
      compileCommandCount: 2,
      warnings: [expect.stringContaining('inferred include directories')]
    })
  })

  it('fails the whole setup when an absolute cmake member fails, with member detail in the log', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-member-fail-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-member-fail-out-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-member-fail-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(workspace, outside, cache)
    const absoluteMember = join(outside, 'lib')
    await mkdir(join(workspace, 'engine'), { recursive: true })
    await mkdir(absoluteMember, { recursive: true })
    await writeFile(join(workspace, 'engine', 'engine.cpp'), 'int engine = 1;')
    await writeFile(join(absoluteMember, 'CMakeLists.txt'), 'project(lib)')
    const run = vi.fn(async () => ({ code: 1, output: 'generator exploded' }))
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
      relativeRoots: ['engine', absoluteMember],
      installMissingTools: true
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('CMake configuration failed')
    expect(result.log).toContain(absoluteMember)
    expect(result.log).toContain('engine')
  })

  it('allows a source-less member when another member has sources, but fails when none do', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-zero-mixed-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-zero-empty-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-zero-cache-'))
    const tools = await createToolDirectory(['clangd'])
    tempDirs.push(workspace, outside, cache)
    const emptyAbsoluteMember = join(outside, 'empty')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await mkdir(emptyAbsoluteMember, { recursive: true })
    await writeFile(join(workspace, 'src', 'main.cpp'), 'int main = 1;')
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
      platform: process.platform,
      env: { ...process.env, PATH: [tools, process.env.PATH ?? ''].join(delimiter) },
      run: vi.fn()
    })

    const mixed = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['src', emptyAbsoluteMember],
      installMissingTools: true
    })
    expect(mixed).toMatchObject({ ok: true, compileCommandCount: 1 })
    const mergedPath = join(mixed.compileCommandsDir!, 'compile_commands.json')

    const allZero = await setup.run({
      repoId: 'repo-1',
      relativeRoots: ['docs', emptyAbsoluteMember],
      installMissingTools: true
    })

    expect(allZero.ok).toBe(false)
    expect(allZero.message).toContain('No compile commands were generated')
    expect(allZero.message).toMatch(/select|choose|source/i)
    // The failed all-zero setup must not clobber the live scope's merged CDB.
    expect(JSON.parse(await readFile(mergedPath, 'utf8'))).toHaveLength(1)
  })

  it('deduplicates a shared TU across overlapping members keeping the last entry', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-dedupe-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-dedupe-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(workspace, cache)
    await mkdir(join(workspace, 'engine'), { recursive: true })
    await writeFile(join(workspace, 'engine', 'CMakeLists.txt'), 'project(engine)')
    await writeFile(join(workspace, 'engine', 'engine.cpp'), 'int engine = 1;')
    const sharedTu = join(workspace, 'engine', 'engine.cpp')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([
          {
            directory: buildDir,
            // cmake spells files with forward slashes while basic emits native joins
            file: sharedTu.replace(/\\/g, '/'),
            command: 'c++ engine.cpp'
          }
        ])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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

    expect(result).toMatchObject({ ok: true, compileCommandCount: 1 })
    const merged = JSON.parse(
      await readFile(join(result.compileCommandsDir!, 'compile_commands.json'), 'utf8')
    )
    expect(merged).toEqual([
      expect.objectContaining({ command: 'c++ engine.cpp' })
    ])
  })

  it('coalesces absolute cmake members through their common parent outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-absolute-cmake-ws-'))
    const parent = await mkdtemp(join(tmpdir(), 'orca-absolute-cmake-parent-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-absolute-cmake-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(workspace, parent, cache)
    await mkdir(join(parent, 'core'), { recursive: true })
    await mkdir(join(parent, 'fx'), { recursive: true })
    await writeFile(join(parent, 'CMakeLists.txt'), 'add_subdirectory(core)')
    await writeFile(join(parent, 'core', 'CMakeLists.txt'), 'project(core)')
    await writeFile(join(parent, 'fx', 'CMakeLists.txt'), 'project(fx)')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: 'a.cpp', command: 'c++ a.cpp' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
      relativeRoots: [join(parent, 'core'), join(parent, 'fx')],
      installMissingTools: true
    })

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['-S', parent]))
  })

  it('never coalesces relative and absolute cmake members across forms', async () => {
    const workspace = await createWorkspace()
    const outside = await mkdtemp(join(tmpdir(), 'orca-crossform-out-'))
    const cache = await mkdtemp(join(tmpdir(), 'orca-crossform-cache-'))
    const tools = await createToolDirectory()
    tempDirs.push(outside, cache)
    const absoluteMember = join(outside, 'sibling')
    await mkdir(absoluteMember, { recursive: true })
    await writeFile(join(absoluteMember, 'CMakeLists.txt'), 'project(sibling)')
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const buildDir = args[args.indexOf('-B') + 1]
      await mkdir(buildDir, { recursive: true })
      await writeFile(
        join(buildDir, 'compile_commands.json'),
        JSON.stringify([{ directory: buildDir, file: 'a.cpp', command: 'c++ a.cpp' }])
      )
      return { code: 0, output: 'configured' }
    })
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace), cache, {
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
      relativeRoots: ['.', absoluteMember],
      installMissingTools: true
    })

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    const sourceDirs = run.mock.calls.map((call) => call[1][call[1].indexOf('-S') + 1])
    expect(sourceDirs).toEqual(expect.arrayContaining([workspace, absoluteMember]))
  })

  it('rejects non-local Hosts before running commands', async () => {
    const workspace = await createWorkspace()
    const run = vi.fn()
    const setup = new CodeIntelligenceCppSetup(fakeStore(workspace, 'ssh:host-1'), workspace, {
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
