import { posix } from 'node:path'
import { shellEscape } from '../ssh/ssh-connection-utils'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import type {
  ManagedLanguageServerActivationRecord
} from '../../shared/managed-language-server'
import { MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE } from './managed-language-server-install-root'
import type { SshSetupExecQueue } from './code-intelligence-ssh-setup-exec'

/** Everything the remote transaction needs; the IPC layer resolves these per
 * request from the live connection and registered remote platform. */
export type SshManagedInstallContext = {
  queue: SshSetupExecQueue
  home: string
  remotePlatform: RemoteOperatingSystem
  remoteArch: 'x64' | 'arm64'
  /** Remote glibc when probed on linux; drives the artifact floor fallback. */
  remoteGlibc?: string
  uploadFile: (localPath: string, remotePath: string, signal?: AbortSignal) => Promise<void>
}

/** Remote layout: ~/.orca/code-intelligence/managed/<tool>/<version> with an
 * activation record beside the immutable version directories (POSIX joins —
 * the remote layout is POSIX regardless of the client platform). */
export function remoteManagedRoot(home: string): string {
  return posix.join(home, '.orca', 'code-intelligence', 'managed')
}

export const remoteManagedToolRoot = (home: string, tool: string): string =>
  posix.join(remoteManagedRoot(home), tool)

export const remoteManagedVersionDirectory = (home: string, tool: string, version: string): string =>
  posix.join(remoteManagedToolRoot(home, tool), version)

const remoteActivationPath = (home: string, tool: string): string =>
  posix.join(remoteManagedToolRoot(home, tool), MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE)

export async function readSshManagedActivation(
  ctx: SshManagedInstallContext,
  tool: string
): Promise<ManagedLanguageServerActivationRecord | null> {
  const result = await ctx.queue.exec(`cat ${shellEscape(remoteActivationPath(ctx.home, tool))}`)
  if (result.code !== 0) {
    return null
  }
  try {
    const record = JSON.parse(result.stdout) as ManagedLanguageServerActivationRecord
    return typeof record?.active?.version === 'string' ? record : null
  } catch {
    return null
  }
}

export async function writeSshManagedActivation(
  ctx: SshManagedInstallContext,
  tool: string,
  record: ManagedLanguageServerActivationRecord
): Promise<void> {
  await ctx.queue.writeFile(
    remoteManagedToolRoot(ctx.home, tool),
    MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE,
    JSON.stringify(record, null, 2)
  )
}

/** Version directories under the remote tool root (staging/records excluded). */
export async function listSshManagedVersions(ctx: SshManagedInstallContext, tool: string): Promise<string[]> {
  const result = await ctx.queue.exec(`ls -1 ${shellEscape(remoteManagedToolRoot(ctx.home, tool))} 2>/dev/null`)
  if (result.code !== 0) {
    return []
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+(\.\d+)+$/.test(line))
}
