import { useState } from 'react'
import { Download, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId, getExecutionHostLabel } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LanguageServerKind } from '../../../../shared/language-server-session'
import type { ManagedLanguageServerInstallState } from '../../../../shared/managed-language-server'
import { formatArchiveSize, MANAGED_ARCHIVE_ACCEPT } from './managed-language-server-recovery-details'
import { managedServerToolLabel } from '@/lib/language-server/managed-language-server-sheet-model'
import type { ManagedInstallActionRoute } from './use-managed-language-server-install'

/** #21 B: the focused task appears only for a Host's first managed install —
 * tool/version, size, source, license, target Host, private directory,
 * transfer route, and the PATH/active-version-untouched safety copy. */
export function ManagedLanguageServerConsentDialog({
  open,
  onOpenChange,
  state,
  executionHostId,
  tool,
  busy,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: ManagedLanguageServerInstallState
  executionHostId: ExecutionHostId
  tool: LanguageServerKind
  busy: boolean
  onConfirm: (route: ManagedInstallActionRoute) => void
}): React.JSX.Element | null {
  const entry = state.latestEntry
  const [route, setRoute] = useState<'host-download' | 'client-file'>('host-download')
  const [clientFile, setClientFile] = useState<string | null>(null)
  const hostLabel = getExecutionHostLabel(executionHostId)
  const hostKind = parseExecutionHostId(executionHostId)?.kind
  if (!open || !entry) {
    return null
  }
  const confirm = (): void => {
    if (route === 'client-file') {
      if (!clientFile) {
        toast.info(
          translate(
            'settings.codeIntelligence.managedInstall.pickFileFirst',
            'Choose the archive file you downloaded'
          )
        )
        return
      }
      onConfirm({ type: 'client-file', filePath: clientFile })
      return
    }
    onConfirm({ type: 'host-download' })
  }
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onOpenChange(next)}>
      <DialogContent className="w-[calc(100%-2rem)] sm:w-[30rem] sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'settings.codeIntelligence.managedInstall.consentTitle',
              'Install managed {{value0}}',
              { value0: managedServerToolLabel(tool) }
            )}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.codeIntelligence.managedInstall.consentSubtitle',
            'First install on {{value0}} — verified by Orca’s trusted manifest.',
            { value0: hostLabel }
          )}
        </p>
        <div className="space-y-1 rounded-md border border-border p-2 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              {translate('settings.codeIntelligence.managedInstall.toolLabel', 'Tool')}
            </span>
            <span>
              {managedServerToolLabel(tool)} {entry.version}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              {translate('settings.codeIntelligence.managedInstall.sizeLabel', 'Size')}
            </span>
            <span className="tabular-nums">{formatArchiveSize(entry.sizeBytes)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              {translate('settings.codeIntelligence.managedInstall.platformLabel', 'Artifact')}
            </span>
            <span>
              {entry.platform} · {entry.arch}
            </span>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">
              {translate('settings.codeIntelligence.managedInstall.licenseLabel', 'License')}
            </span>
            <button
              type="button"
              className="truncate underline-offset-2 hover:underline"
              onClick={() => void window.api.shell.openUrl(entry.license.url)}
            >
              {entry.license.name}
            </button>
          </div>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">
              {translate('settings.codeIntelligence.managedInstall.downloadLink', 'Download link')}
            </span>
            <span className="truncate font-mono text-[11px]" title={entry.sourceUrl}>
              {entry.sourceUrl}
            </span>
          </div>
        </div>
        <div className="space-y-1.5 rounded-md bg-muted/50 p-2 text-xs">
          <div className="flex items-start gap-1.5">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {hostKind === 'local'
                ? translate(
                    'settings.codeIntelligence.managedInstall.privateDirLocal',
                    'Installs into Orca’s private app-data folder. PATH and global package managers are never touched.'
                  )
                : translate(
                    'settings.codeIntelligence.managedInstall.privateDirRemote',
                    'Installs into ~/.orca/code-intelligence/managed on {{value0}}. PATH and global package managers are never touched.',
                    { value0: hostLabel }
                  )}
            </span>
          </div>
          {state.activeVersion ? (
            <div className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {translate(
                  'settings.codeIntelligence.managedInstall.consentSafetyActive',
                  '{{value0}} keeps serving Code results until the new version verifies and activates.',
                  { value0: `${managedServerToolLabel(tool)} ${state.activeVersion}` }
                )}
              </span>
            </div>
          ) : null}
        </div>
        <fieldset className="space-y-1.5 text-xs">
          <legend className="mb-1 font-medium">
            {translate(
              'settings.codeIntelligence.managedInstall.routeLegend',
              'Transfer route'
            )}
          </legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="managed-install-route"
              checked={route === 'host-download'}
              onChange={() => setRoute('host-download')}
            />
            {translate(
              'settings.codeIntelligence.managedInstall.consentRouteHost',
              'Download directly on {{value0}}',
              { value0: hostLabel }
            )}
          </label>
          {hostKind !== 'runtime' ? (
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="managed-install-route"
                checked={route === 'client-file'}
                onChange={() => setRoute('client-file')}
              />
              {translate(
                'settings.codeIntelligence.managedInstall.consentRouteClient',
                'Upload an archive already downloaded on this computer'
              )}
            </label>
          ) : null}
          {route === 'client-file' ? (
            <div className="pl-6">
              <input
                type="file"
                aria-label={translate(
                  'settings.codeIntelligence.managedInstall.selectOfflineFile',
                  'Select downloaded file'
                )}
                accept={MANAGED_ARCHIVE_ACCEPT}
                className="w-full text-[11px]"
                onChange={(change) => {
                  const file = change.target.files?.[0]
                  setClientFile(
                    file ? window.api.codeIntelligence.localFilePathForFile(file) : null
                  )
                }}
              />
            </div>
          ) : null}
        </fieldset>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {translate('settings.codeIntelligence.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="xs" disabled={busy} onClick={confirm}>
            <Download className="size-3.5" />
            {translate('settings.codeIntelligence.managedInstall.confirmInstall', 'Install {{value0}}', {
              value0: managedServerToolLabel(tool)
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
