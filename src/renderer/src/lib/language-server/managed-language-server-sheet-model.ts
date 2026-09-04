import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallState
} from '../../../../shared/managed-language-server'
import type { LanguageServerKind } from '../../../../shared/language-server-session'

export function managedServerToolLabel(tool: LanguageServerKind): string {
  return tool === 'clangd' ? 'clangd' : tool === 'basedpyright' ? 'BasedPyright' : 'Pyright'
}

export type ManagedServerSheetStatus =
  | 'unsupported'
  | 'needs-first-install'
  | 'installing'
  | 'failed'
  | 'canceled'
  | 'update-available'
  | 'active'

export type ManagedServerSheetView = {
  status: ManagedServerSheetStatus
  progressPercent: number | null
  /** #21 interruption policy: failures and unsupported Hosts auto-expand the sheet. */
  needsAttention: boolean
  /** Version still serving results while a replacement installs (#15 safety). */
  safeActiveVersion: string | null
  failureMessage: string | null
}

const BYTE_PHASES = new Set(['download', 'upload'])

export function managedInstallProgressPercent(
  event: Pick<ManagedLanguageServerInstallEvent, 'phase' | 'receivedBytes' | 'totalBytes'> | null
): number | null {
  if (!event || !BYTE_PHASES.has(event.phase) || !event.receivedBytes || !event.totalBytes) {
    return null
  }
  return Math.min(100, Math.round((event.receivedBytes / event.totalBytes) * 100))
}

/** Status-sheet projection of one Host+tool pair: live event beats snapshot,
 * terminal 'complete' is left to the refreshed snapshot. */
export function deriveManagedServerSheetView(args: {
  state: ManagedLanguageServerInstallState | null
  event: ManagedLanguageServerInstallEvent | null
  /** Runtime Host without the managed-install capability (#34 mixed-version gate). */
  runtimeCapabilityUnsupported?: boolean
}): ManagedServerSheetView | null {
  if (args.runtimeCapabilityUnsupported) {
    return {
      status: 'unsupported',
      progressPercent: null,
      needsAttention: true,
      safeActiveVersion: null,
      failureMessage: null
    }
  }
  const { state, event } = args
  if (!state) {
    return null
  }
  const base = {
    progressPercent: managedInstallProgressPercent(event),
    safeActiveVersion: state.activeVersion,
    failureMessage: null as string | null
  }
  if (!state.supported) {
    return { ...base, status: 'unsupported', needsAttention: true }
  }
  if (event?.phase === 'error') {
    return event.canceled
      ? { ...base, status: 'canceled', needsAttention: false }
      : { ...base, status: 'failed', needsAttention: true, failureMessage: event.message ?? null }
  }
  if (event && event.phase !== 'complete') {
    return { ...base, status: 'installing', needsAttention: false }
  }
  if (state.activeVersion === null) {
    return { ...base, status: 'needs-first-install', needsAttention: false }
  }
  return {
    ...base,
    status: state.updateAvailable ? 'update-available' : 'active',
    needsAttention: false
  }
}

/** #21: the focused consent task runs only for a Host's first managed install. */
export function needsFirstManagedInstallConsent(
  state: Pick<ManagedLanguageServerInstallState, 'activeVersion' | 'installedVersions'>
): boolean {
  return state.activeVersion === null && state.installedVersions.length === 0
}
