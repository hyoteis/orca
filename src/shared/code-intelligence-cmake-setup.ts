export type CodeIntelligenceCmakeSetupRequest = {
  repoId: string
  relativeRoots: string[]
  installMissingTools: boolean
}

export type CodeIntelligenceCmakeSetupResult = {
  ok: boolean
  message: string
  log: string
  relativeRoots: string[]
  installedTools: string[]
  clangdExecutable?: string
  compileCommandsDir?: string
}
