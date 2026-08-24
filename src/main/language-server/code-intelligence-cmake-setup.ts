import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Store } from '../persistence'
import type {
  CodeIntelligenceCmakeSetupRequest,
  CodeIntelligenceCmakeSetupResult
} from '../../shared/code-intelligence-cmake-setup'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { normalizeScopeRelativePath } from '../../shared/code-intelligence-scope'
import {
  appendCmakeSetupLog,
  discoverCmakeSetupTools,
  installCmakeSetupTools,
  resolveCmakeSetupEnvironment,
  runCmakeSetupCommand,
  type CmakeSetupCommandRunner
} from './code-intelligence-cmake-tools'

type SetupDependencies = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: CmakeSetupCommandRunner
}

function setupCacheKey(repoId: string, roots: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ repoId, roots })).digest('hex').slice(0, 16)
}

async function mergeCompileCommands(
  buildDirs: readonly string[],
  destination: string
): Promise<void> {
  const entries: unknown[] = []
  for (const buildDir of buildDirs) {
    const parsed = JSON.parse(await readFile(join(buildDir, 'compile_commands.json'), 'utf8'))
    if (!Array.isArray(parsed)) {
      throw new Error('CMake produced an invalid compile_commands.json')
    }
    entries.push(...parsed)
  }
  await writeFile(join(destination, 'compile_commands.json'), JSON.stringify(entries, null, 2))
}

export class CodeIntelligenceCmakeSetup {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly runCommand: CmakeSetupCommandRunner

  constructor(
    private readonly store: Store,
    private readonly cacheRoot: string,
    dependencies: SetupDependencies = {}
  ) {
    this.platform = dependencies.platform ?? process.platform
    this.env = dependencies.env ?? process.env
    this.runCommand = dependencies.run ?? runCmakeSetupCommand
  }

  async run(request: CodeIntelligenceCmakeSetupRequest): Promise<CodeIntelligenceCmakeSetupResult> {
    const logs: string[] = []
    const fail = (message: string, roots: string[], installedTools: string[] = []) => ({
      ok: false,
      message,
      log: logs.join('\n').trim(),
      relativeRoots: roots,
      installedTools
    })
    let roots: string[] = []
    let installedTools: string[] = []
    try {
      const repo = this.store.getRepo(request.repoId)
      if (!repo) {
        return fail('Project is no longer available', roots)
      }
      if (getRepoExecutionHostId(repo) !== 'local') {
        return fail('One-click CMake setup currently requires a local Host', roots)
      }
      roots = [...new Set(request.relativeRoots.map(normalizeScopeRelativePath))]
      if (roots.length === 0) {
        return fail('Select at least one CMake directory', roots)
      }
      const workspaceRoot = resolve(repo.path)
      for (const root of roots) {
        await access(join(workspaceRoot, root, 'CMakeLists.txt'), constants.R_OK)
      }
      let tools = await discoverCmakeSetupTools(this.platform, this.env)
      const missing = (['clangd', 'cmake', 'ninja'] as const).filter((tool) => !tools[tool])
      if (missing.length > 0) {
        if (!request.installMissingTools) {
          return fail(`Missing tools: ${missing.join(', ')}`, roots)
        }
        installedTools = await installCmakeSetupTools({
          missing,
          platform: this.platform,
          cwd: workspaceRoot,
          run: this.runCommand,
          logs
        })
        tools = await discoverCmakeSetupTools(this.platform, this.env)
      }
      const stillMissing = (['clangd', 'cmake', 'ninja'] as const).filter((tool) => !tools[tool])
      if (stillMissing.length > 0) {
        return fail(
          `Installed tools were not found: ${stillMissing.join(', ')}`,
          roots,
          installedTools
        )
      }
      const commandEnvironment = await resolveCmakeSetupEnvironment(this.platform, this.env, logs)
      const outputRoot = join(this.cacheRoot, setupCacheKey(repo.id, roots))
      await mkdir(outputRoot, { recursive: true })
      const buildDirs: string[] = []
      for (const [index, root] of roots.entries()) {
        const sourceDir = join(workspaceRoot, root)
        const buildDir = join(outputRoot, `build-${index + 1}`)
        await rm(buildDir, { recursive: true, force: true })
        await mkdir(buildDir, { recursive: true })
        const commandArgs = [
          '-S',
          sourceDir,
          '-B',
          buildDir,
          '-G',
          'Ninja',
          `-DCMAKE_MAKE_PROGRAM=${tools.ninja}`,
          '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
          '-DCMAKE_BUILD_TYPE=Debug'
        ]
        const result = await this.runCommand(
          tools.cmake!,
          commandArgs,
          workspaceRoot,
          commandEnvironment
        )
        appendCmakeSetupLog(logs, `Configure ${root}`, [tools.cmake!, ...commandArgs], result)
        if (result.code !== 0) {
          return fail(`CMake configuration failed for ${root}`, roots, installedTools)
        }
        buildDirs.push(buildDir)
      }
      await mergeCompileCommands(buildDirs, outputRoot)
      return {
        ok: true,
        message: `Generated compile commands for ${roots.length} CMake director${roots.length === 1 ? 'y' : 'ies'}`,
        log: logs.join('\n').trim(),
        relativeRoots: roots,
        installedTools,
        clangdExecutable: tools.clangd,
        compileCommandsDir: outputRoot
      }
    } catch (error) {
      logs.push(
        `\n## Error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
      return fail(error instanceof Error ? error.message : String(error), roots, installedTools)
    }
  }
}
