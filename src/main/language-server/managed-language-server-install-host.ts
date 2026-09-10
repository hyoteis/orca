import type {
  ManagedLanguageServerActivationRecord,
  ManagedLanguageServerHostTarget,
  ManagedLanguageServerInstallPhase,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifestEntry,
  ManagedLanguageServerToolId
} from '../../shared/managed-language-server'

/** Progress sink the pipeline hands to acquire(); the pipeline fills in
 * executionHostId/tool/version, so a Host only reports its own phases. */
export type ManagedAcquireProgress = (
  phase: ManagedLanguageServerInstallPhase,
  extra?: { receivedBytes?: number; totalBytes?: number }
) => void

/** Per-Host primitives behind the managed-install pipeline (#151): the
 * pipeline owns lock/abort/event/branch/activation/GC policy; each Host
 * implements storage and acquisition in its own idiom. Parallel to CppSetupHost. */
export type ManagedLanguageServerInstallHost = {
  hostTarget(): Promise<ManagedLanguageServerHostTarget>
  readActivation(
    tool: ManagedLanguageServerToolId
  ): Promise<ManagedLanguageServerActivationRecord | null>
  writeActivation(
    tool: ManagedLanguageServerToolId,
    record: ManagedLanguageServerActivationRecord
  ): Promise<void>
  listVersions(tool: ManagedLanguageServerToolId): Promise<string[]>
  /** Smoke test an installed version; throwing aborts before activation. */
  probeVersion(entry: ManagedLanguageServerManifestEntry): Promise<void>
  /** Stage → verify → extract → probe → atomic adopt of one immutable
   * version; failure removes only staging. */
  acquire(args: {
    entry: ManagedLanguageServerManifestEntry
    route: ManagedLanguageServerInstallRoute
    signal: AbortSignal
    emit: ManagedAcquireProgress
  }): Promise<void>
  removeVersion(tool: ManagedLanguageServerToolId, version: string): Promise<void>
}
