import { join } from 'node:path'
import { runCppSetupCommand, type CppSetupCommandRunner } from './code-intelligence-cpp-command-runner'
import {
  acquireManagedVersion,
  probeManagedEntry,
  resolveLocalManagedHostTarget
} from './managed-language-server-acquisition'
import type { FetchManagedArchive } from './managed-language-server-archive'
import {
  listManagedVersions,
  managedToolRoot,
  managedVersionDirectory,
  readManagedActivation,
  writeManagedActivation
} from './managed-language-server-install-root'
import type { ManagedLanguageServerInstallHost } from './managed-language-server-install-host'

export type LocalManagedLanguageServerInstallHostOptions = {
  root: string
  fetchArchive?: FetchManagedArchive
  run?: CppSetupCommandRunner
}

/** Local-Host adapter (#151): streaming verify-while-download acquisition
 * over the <userData>/code-intelligence/managed layout. Electron-free, so the
 * relay Runtime Host reuses it under ~/.orca. */
export function createLocalManagedLanguageServerInstallHost(
  options: LocalManagedLanguageServerInstallHostOptions
): ManagedLanguageServerInstallHost {
  const run: CppSetupCommandRunner = (executable, args, cwd) =>
    (options.run ?? runCppSetupCommand)(executable, args, cwd)
  return {
    hostTarget: () => resolveLocalManagedHostTarget(run),
    readActivation: (tool) => readManagedActivation(managedToolRoot(options.root, tool)),
    writeActivation: (tool, record) =>
      writeManagedActivation(managedToolRoot(options.root, tool), record),
    listVersions: (tool) => listManagedVersions(managedToolRoot(options.root, tool)),
    probeVersion: (entry) =>
      probeManagedEntry(
        entry,
        managedVersionDirectory(options.root, entry.tool, entry.version),
        run
      ),
    acquire: async (args) =>
      acquireManagedVersion({
        root: options.root,
        entry: args.entry,
        route: args.route,
        signal: args.signal,
        seams: {
          run,
          fetchArchive: options.fetchArchive,
          emit: (_entry, phase, extra) => args.emit(phase, extra)
        }
      }),
    removeVersion: async (tool, version) => {
      const { rm } = await import('node:fs/promises')
      await rm(join(managedToolRoot(options.root, tool), version), { recursive: true, force: true })
    }
  }
}
