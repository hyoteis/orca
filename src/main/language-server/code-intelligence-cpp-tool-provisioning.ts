import {
  discoverBundledGn,
  discoverCppSetupTools,
  installCppSetupTools,
  type CppSetupCommandRunner,
  type CppSetupToolName,
  type CppSetupToolPaths
} from './code-intelligence-cpp-setup-tools'
import {
  discoverCachedWindowsGn,
  installCachedWindowsGn
} from './code-intelligence-windows-gn-installer'

async function discoverTools(args: {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  cacheRoot: string
  workspaceRoot: string
}): Promise<CppSetupToolPaths> {
  const tools = await discoverCppSetupTools(args.platform, args.env)
  tools.gn ??= (await discoverBundledGn(args.workspaceRoot, args.platform)) ?? undefined
  tools.gn ??=
    (await discoverCachedWindowsGn(args.cacheRoot, args.platform, args.arch)) ?? undefined
  return tools
}

export async function provisionCppSetupTools(args: {
  requiredTools: ReadonlySet<CppSetupToolName>
  installMissingTools: boolean
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  cacheRoot: string
  workspaceRoot: string
  run: CppSetupCommandRunner
  logs: string[]
}): Promise<{ tools: CppSetupToolPaths; installedTools: string[] }> {
  let tools = await discoverTools(args)
  let missing = [...args.requiredTools].filter((tool) => !tools[tool])
  if (missing.length === 0) {
    return { tools, installedTools: [] }
  }
  if (!args.installMissingTools) {
    throw new Error(`Missing tools: ${missing.join(', ')}`)
  }
  const installedTools: string[] = []
  if (args.platform === 'win32' && missing.includes('gn')) {
    await installCachedWindowsGn({
      cacheRoot: args.cacheRoot,
      platform: args.platform,
      arch: args.arch,
      run: args.run,
      logs: args.logs
    })
    installedTools.push('gn')
    missing = missing.filter((tool) => tool !== 'gn')
  }
  if (missing.length > 0) {
    installedTools.push(
      ...(await installCppSetupTools({
        missing,
        platform: args.platform,
        cwd: args.workspaceRoot,
        run: args.run,
        logs: args.logs
      }))
    )
  }
  tools = await discoverTools(args)
  const stillMissing = [...args.requiredTools].filter((tool) => !tools[tool])
  if (stillMissing.length > 0) {
    throw new Error(`Installed tools were not found: ${stillMissing.join(', ')}`)
  }
  return { tools, installedTools }
}
