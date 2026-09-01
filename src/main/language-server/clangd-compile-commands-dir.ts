import { stat } from 'node:fs/promises'
import { CLANGD_COMPILE_COMMANDS_DIR_ARG_PREFIX } from '../../shared/code-intelligence-cpp-setup'
import type {
  LanguageServerKind,
  LanguageServerLaunchRequest
} from '../../shared/language-server-session'
import { resolveDefaultLocalLanguageServerCommand } from './local-language-server-session-manager'

export function clangdCompileCommandsDirFromArgs(
  kind: LanguageServerKind,
  args: readonly string[]
): string | null {
  if (kind !== 'clangd') {
    return null
  }
  const arg = args.find((candidate) => candidate.startsWith(CLANGD_COMPILE_COMMANDS_DIR_ARG_PREFIX))
  return arg ? arg.slice(CLANGD_COMPILE_COMMANDS_DIR_ARG_PREFIX.length) || null : null
}

export async function localDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** A missing dir would make clangd silently degrade to per-file ancestor CDB search (spec §2 M17). */
export async function assertClangdCompileCommandsDirExists(
  launch: LanguageServerLaunchRequest,
  directoryExists: (directory: string) => Promise<boolean>
): Promise<void> {
  const directory = clangdCompileCommandsDirFromArgs(
    launch.kind,
    resolveDefaultLocalLanguageServerCommand(launch).args
  )
  if (directory === null || (await directoryExists(directory))) {
    return
  }
  throw new Error(
    `clangd compile commands directory is missing on the execution Host: ${directory}. Re-run C++ setup.`
  )
}
