import type { ExecutionHostId } from './execution-host'
import type { LanguageServerKind } from './language-server-session'
import { LANGUAGE_SERVER_MANAGED_INSTALL_RUNTIME_CAPABILITY } from './protocol-version'

export type ManagedLanguageServerToolId = 'basedpyright' | 'pyright' | 'clangd' | 'node'

export {
  /** Canonical wire capability (#15); protocol-version owns the registry. */
  LANGUAGE_SERVER_MANAGED_INSTALL_RUNTIME_CAPABILITY
}

/** What the executing Host reports about itself; drives entry matching. */
export type ManagedLanguageServerHostTarget = {
  platform: string
  arch: string
  /** Linux only, when known (e.g. '2.35'); artifacts pin the 2.31 floor. */
  glibcVersion?: string
}

export type ManagedLanguageServerArchiveFormat = 'zip' | 'tar-gz' | 'tar-xz'

/** Path templates: `{root}` = the tool's version directory, `{runtime}` = the
 * private runtime version directory (managed Node; empty for clangd). Forward
 * slashes — Windows accepts them, so no per-host conversion is needed. */
export type ManagedLanguageServerCommandTemplate = {
  executable: string
  args: readonly string[]
}

export type ManagedLanguageServerManifestEntry = {
  id: string
  /** 'node' marks a private managed runtime (excluded from server listings
   * and unrequestable by install IPC; referenced via runtimeEntryId). */
  tool: ManagedLanguageServerToolId
  version: string
  platform: 'win32' | 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
  /** Minimum glibc (Ubuntu 20.04 floor = 2.31) for linux artifacts. */
  glibcFloor?: string
  sourceUrl: string
  archiveFileName: string
  archiveFormat: ManagedLanguageServerArchiveFormat
  sizeBytes: number
  sha256: string
  /** Archive member directory adopted as the immutable version root ('.' = root). */
  archiveRootDirectory: string
  /** Post-extraction smoke test; a non-zero exit aborts before activation. */
  probe: ManagedLanguageServerCommandTemplate
  /** Session launch command resolved at activation time. */
  command: ManagedLanguageServerCommandTemplate
  /** Private managed Node runtime this entry needs (Python servers). */
  runtimeEntryId?: string
  license: { name: string; url: string }
}

export type ManagedLanguageServerManifest = {
  manifestVersion: number
  entries: readonly ManagedLanguageServerManifestEntry[]
}

export type ManagedLanguageServerUnsupportedReason =
  | { type: 'unsupported-platform'; platform: string; arch: string }
  | { type: 'unsupported-glibc'; glibcVersion: string; floor: string }
  | { type: 'unknown-version'; tool: ManagedLanguageServerToolId; version: string }

export type ManagedLanguageServerActivationRecord = {
  active: { version: string; entryId: string; activatedAt: number }
  rollback?: { version: string; entryId: string; activatedAt: number }
}

export type ManagedLanguageServerInstallRoute =
  | { type: 'host-download' }
  /** Client-downloaded file or a user-selected offline archive — both are a
   * local file verified against the manifest before any extraction. */
  | { type: 'client-file'; filePath: string }

export type ManagedLanguageServerInstallRequest = {
  executionHostId: ExecutionHostId
  tool: LanguageServerKind
  version?: string
  route: ManagedLanguageServerInstallRoute
}

export type ManagedLanguageServerInstallResult =
  | { status: 'installed'; version: string }
  | { status: 'already-active'; version: string }
  | { status: 'unsupported'; reason: ManagedLanguageServerUnsupportedReason }
  | { status: 'canceled' }
  | { status: 'failed'; error: string }

export type ManagedLanguageServerRollbackResult =
  | { status: 'rolled-back'; version: string }
  | { status: 'no-rollback' }
  | { status: 'failed'; error: string }

export type ManagedLanguageServerInstallPhase =
  | 'download'
  | 'upload'
  | 'verify'
  | 'extract'
  | 'probe'
  | 'activate'

export type ManagedLanguageServerInstallEvent = {
  executionHostId: ExecutionHostId
  /** 'node' marks private-runtime internals; status sheets show servers only. */
  tool: ManagedLanguageServerToolId
  version: string
  phase: ManagedLanguageServerInstallPhase | 'complete' | 'error'
  receivedBytes?: number
  totalBytes?: number
  /** Error text when phase is 'error'. */
  message?: string
  canceled?: boolean
}

/** Snapshot per tool for the status sheet: installed versions, activation,
 * and the latest trusted offer the manifest supports for this Host. */
export type ManagedLanguageServerInstallState = {
  tool: LanguageServerKind
  supported: boolean
  unsupportedReason?: ManagedLanguageServerUnsupportedReason
  activeVersion: string | null
  rollbackVersion: string | null
  installedVersions: string[]
  /** The newest entry the trusted manifest offers for this Host+tool;
   * null when unsupported. Also drives the download-failure guidance UI. */
  latestEntry: ManagedLanguageServerManifestEntry | null
  updateAvailable: boolean
}

/** Dotted numeric compare ('22.1.6' > '22.1' > '9.0.0'); suffixes ignored. */
export function compareManagedLanguageServerVersions(
  left: string,
  right: string
): number {
  const parse = (value: string): number[] =>
    value.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : 0))
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) {
      return delta
    }
  }
  return 0
}

function glibcAtLeast(version: string | undefined, floor: string): boolean {
  if (!version) {
    return true // Unknown glibc: attempt, never block on missing telemetry.
  }
  return compareManagedLanguageServerVersions(version, floor) >= 0
}

/** Pure entry matching shared by every Host adapter: clients pass manifest
 * ids/versions only — never URLs or hashes (#15 trust rule). */
export function resolveManagedLanguageServerEntry(
  manifest: ManagedLanguageServerManifest,
  target: { tool: ManagedLanguageServerToolId; version?: string },
  host: ManagedLanguageServerHostTarget
):
  | { entry: ManagedLanguageServerManifestEntry; runtimeEntry?: ManagedLanguageServerManifestEntry }
  | { unsupported: ManagedLanguageServerUnsupportedReason } {
  const forTool = manifest.entries.filter((entry) => entry.tool === target.tool)
  // Platform filter first: one version ships several per-Host entries, and the
  // "latest" pick must never cross-match onto another platform's artifact.
  const platformEntries = forTool.filter(
    (entry) => entry.platform === host.platform && entry.arch === host.arch
  )
  const requested = target.version
    ? platformEntries.find((entry) => entry.version === target.version)
    : [...platformEntries].sort(
        (a, b) => compareManagedLanguageServerVersions(b.version, a.version)
      )[0]
  if (target.version && !requested) {
    // Known version but not for this Host → platform fallback, not version error.
    if (forTool.some((entry) => entry.version === target.version)) {
      return { unsupported: { type: 'unsupported-platform', platform: host.platform, arch: host.arch } }
    }
    return { unsupported: { type: 'unknown-version', tool: target.tool, version: target.version } }
  }
  if (!requested) {
    return { unsupported: { type: 'unsupported-platform', platform: host.platform, arch: host.arch } }
  }
  if (host.platform === 'linux' && !glibcAtLeast(host.glibcVersion, requested.glibcFloor ?? '2.31')) {
    return {
      unsupported: {
        type: 'unsupported-glibc',
        glibcVersion: host.glibcVersion!,
        floor: requested.glibcFloor ?? '2.31'
      }
    }
  }
  const runtimeEntry = requested.runtimeEntryId
    ? manifest.entries.find((entry) => entry.id === requested.runtimeEntryId)
    : undefined
  if (requested.runtimeEntryId && !runtimeEntry) {
    return { unsupported: { type: 'unknown-version', tool: target.tool, version: requested.runtimeEntryId } }
  }
  return { entry: requested, runtimeEntry }
}

/** Substitute {root}/{runtime} placeholders in a probe/launch template. */
export function resolveManagedLanguageServerCommand(
  template: ManagedLanguageServerCommandTemplate,
  roots: { root: string; runtimeRoot?: string }
): { executable: string; args: string[] } {
  const substitute = (value: string): string =>
    value.replaceAll('{root}', roots.root).replaceAll('{runtime}', roots.runtimeRoot ?? '')
  if (template.executable.includes('{runtime}') && !roots.runtimeRoot) {
    throw new Error('Managed command needs a runtime root but none was resolved')
  }
  return { executable: substitute(template.executable), args: template.args.map(substitute) }
}
