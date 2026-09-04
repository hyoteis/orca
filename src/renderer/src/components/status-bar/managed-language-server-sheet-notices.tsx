import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type {
  ManagedLanguageServerInstallPhase,
  ManagedLanguageServerUnsupportedReason
} from '../../../../shared/managed-language-server'

export const PHASE_LABELS: Record<ManagedLanguageServerInstallPhase, { key: string; fallback: string }> = {
  download: { key: 'settings.codeIntelligence.managedInstall.phaseDownload', fallback: 'Downloading' },
  upload: { key: 'settings.codeIntelligence.managedInstall.phaseUpload', fallback: 'Uploading' },
  verify: { key: 'settings.codeIntelligence.managedInstall.phaseVerify', fallback: 'Verifying' },
  extract: { key: 'settings.codeIntelligence.managedInstall.phaseExtract', fallback: 'Extracting' },
  probe: { key: 'settings.codeIntelligence.managedInstall.phaseProbe', fallback: 'Running smoke test' },
  activate: { key: 'settings.codeIntelligence.managedInstall.phaseActivate', fallback: 'Activating' }
}

/** #15 active-version safety: the running version visibly keeps serving. */
export function SafeVersionNotice({ version }: { version: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-muted/50 p-1.5 text-[11px]">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {translate(
          'settings.codeIntelligence.managedInstall.safeVersionNotice',
          '{{value0}} stays active until the new version verifies and activates.',
          { value0: version }
        )}
      </span>
    </div>
  )
}

export function UnsupportedHostBody({
  reason,
  runtimeCapabilityUnsupported
}: {
  reason: ManagedLanguageServerUnsupportedReason | null | undefined
  runtimeCapabilityUnsupported: boolean
}): React.JSX.Element {
  const text = runtimeCapabilityUnsupported
    ? translate(
        'settings.codeIntelligence.managedInstall.unsupportedCapability',
        'This Host version does not support managed installs. Keep using your own server installation.'
      )
    : reason?.type === 'unsupported-glibc'
      ? translate(
          'settings.codeIntelligence.managedInstall.unsupportedGlibc',
          'Host glibc {{value0}} is older than the pinned floor {{value1}}. Orca will not compile from source.',
          { value0: reason.glibcVersion, value1: reason.floor }
        )
      : translate(
          'settings.codeIntelligence.managedInstall.unsupportedPlatform',
          'No verified build for {{value0}}/{{value1}}. Orca will not compile from source.',
          {
            value0: reason?.type === 'unsupported-platform' ? reason.platform : '',
            value1: reason?.type === 'unsupported-platform' ? reason.arch : ''
          }
        )
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{text}</span>
      </div>
      <p className="text-muted-foreground">
        {translate(
          'settings.codeIntelligence.managedInstall.unsupportedFallback',
          'Scopes can still use PATH-discovered or custom executables.'
        )}
      </p>
    </div>
  )
}
