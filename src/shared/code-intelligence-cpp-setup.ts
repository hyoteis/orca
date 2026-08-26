import type {
  CodeIntelligenceConfigurationMode,
  CodeIntelligenceSetupStatus
} from './code-intelligence-scope'

export type CodeIntelligenceCppSetupRequest = {
  repoId: string
  relativeRoots: string[]
  workspaceDirectories?: string[]
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
  workspaceDirectories?: string[]
  installedTools: string[]
  clangdExecutable?: string
  compileCommandsDir?: string
  configurationMode?: CodeIntelligenceConfigurationMode
  healthState?: CodeIntelligenceSetupStatus['state']
  compileCommandCount?: number
  warnings?: string[]
}
