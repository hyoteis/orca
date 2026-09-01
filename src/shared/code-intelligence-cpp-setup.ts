import type {
  CodeIntelligenceConfigurationMode,
  CodeIntelligenceSetupStatus
} from './code-intelligence-scope'

/** Single writer/reader source for the clangd spawn arg; extraction must match (spec §2 M17). */
export const CLANGD_COMPILE_COMMANDS_DIR_ARG_PREFIX = '--compile-commands-dir='

export function clangdCompileCommandsDirArg(directory: string): string {
  return `${CLANGD_COMPILE_COMMANDS_DIR_ARG_PREFIX}${directory}`
}

export type CodeIntelligenceCppSetupRequest = {
  repoId: string
  relativeRoots: string[]
  installMissingTools: boolean
  additionalIncludeDirectories?: string[]
  defines?: string[]
  cppStandard?: 'c++17' | 'c++20' | 'c++23'
}

export type CodeIntelligenceCppSetupResult = {
  ok: boolean
  message: string
  log: string
  relativeRoots: string[]
  installedTools: string[]
  clangdExecutable?: string
  compileCommandsDir?: string
  configurationMode?: CodeIntelligenceConfigurationMode
  healthState?: CodeIntelligenceSetupStatus['state']
  compileCommandCount?: number
  warnings?: string[]
}
