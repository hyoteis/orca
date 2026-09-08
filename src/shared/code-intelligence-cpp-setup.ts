import type {
  CodeIntelligenceBasicOptions,
  CodeIntelligenceSetupStatus,
  CodeIntelligenceSetupSystemMode
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
  /** Dialog re-run: regenerate even on a fingerprint cache hit — nested
   * CMakeLists changes (e.g. a new subdirectory) are invisible to the
   * fingerprint, which only stats build-root manifests. */
  force?: boolean
  additionalIncludeDirectories?: string[]
  defines?: string[]
  /** KEY=VALUE lines passed as -D args to every CMake configure — the escape
   * hatch for cross compiles (e.g. CMAKE_TOOLCHAIN_FILE=…ohos.toolchain.cmake). */
  cmakeDefines?: string[]
  cppStandard?: 'c++17' | 'c++20' | 'c++23'
  /** Per-scope persisted BASIC options (#129) — joins the setup fingerprint;
   * the flat fields above stay the wire shape until the Step 5 UI migration. */
  basicOptions?: CodeIntelligenceBasicOptions
}

export type CodeIntelligenceCppSetupResult = {
  ok: boolean
  message: string
  log: string
  relativeRoots: string[]
  installedTools: string[]
  clangdExecutable?: string
  compileCommandsDir?: string
  configurationMode?: CodeIntelligenceSetupSystemMode
  healthState?: CodeIntelligenceSetupStatus['state']
  compileCommandCount?: number
  warnings?: string[]
}
