import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  Loader2,
  RefreshCw,
  RotateCcw,
  Server
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { languageServerKindForScope } from '../../../../shared/code-intelligence-scope'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  getExecutionHostLabel,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LanguageServerKind } from '../../../../shared/language-server-session'
import {
  deriveManagedServerSheetView,
  managedServerToolLabel,
  needsFirstManagedInstallConsent
} from '@/lib/language-server/managed-language-server-sheet-model'
import { useManagedSheetActions } from './managed-language-server-sheet-actions'
import { ManagedLanguageServerConsentDialog } from './ManagedLanguageServerConsentDialog'
import {
  MANAGED_ARCHIVE_ACCEPT,
  ManagedLanguageServerRecoveryDetails
} from './managed-language-server-recovery-details'
import {
  PHASE_LABELS,
  SafeVersionNotice,
  UnsupportedHostBody
} from './managed-language-server-sheet-notices'
import {
  getLastOfflineManagedArchive,
  useManagedLanguageServerInstall
} from './use-managed-language-server-install'

/** One collapsible Host+tool row of the #21 C status sheet. */
export function ManagedLanguageServerToolSheet({
  tool,
  executionHostId,
  scopes
}: {
  tool: LanguageServerKind
  executionHostId: ExecutionHostId
  scopes: readonly CodeIntelligenceScope[]
}): React.JSX.Element | null {
  const controller = useManagedLanguageServerInstall({ executionHostId, tool })
  const [downloadsPath, setDownloadsPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const view = deriveManagedServerSheetView({
    state: controller.state,
    event: controller.event,
    runtimeCapabilityUnsupported: controller.runtimeCapabilityUnsupported
  })
  const hostLabel = getExecutionHostLabel(executionHostId)
  const hostKind = parseExecutionHostId(executionHostId)?.kind ?? 'local'

  useEffect(() => {
    // Optional chain: partial window.api mocks in unrelated StatusBar tests.
    window.api.codeIntelligence
      ?.managedInstallDownloadsPath?.()
      .then(setDownloadsPath)
      .catch(() => setDownloadsPath(null))
  }, [])

  // #21 interruption policy: failures and unsupported Hosts expand the sheet;
  // an install start expands once so progress is visible, then stays minimizable.
  useEffect(() => {
    if (view?.needsAttention || view?.status === 'installing') {
      setExpanded(true)
    }
  }, [view?.needsAttention, view?.status])
  // SSH installs emit terminal events only (#34) — busy itself must show.
  useEffect(() => {
    if (controller.busy) {
      setExpanded(true)
    }
  }, [controller.busy])

  // Hooks stay above the early return below (stable hook order).
  const toolScopes = scopes.filter((scope) => languageServerKindForScope(scope.language) === tool)
  const label = managedServerToolLabel(tool)
  const { runInstall, handleRollback, handleUseManaged, rollbackFailure } = useManagedSheetActions({
    controller,
    label,
    toolScopes
  })
  // #21 policy: rollback failure needs user action — expand and surface it.
  useEffect(() => {
    if (rollbackFailure) {
      setExpanded(true)
    }
  }, [rollbackFailure])

  if (!view) {
    return controller.stateError ? (
      <div className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground">
        <Server className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {managedServerToolLabel(tool)} —{' '}
          {translate(
            'settings.codeIntelligence.managedInstall.statusUnavailable',
            'Status unavailable'
          )}
        </span>
      </div>
    ) : null
  }

  const statusText = {
    unsupported: translate(
      'settings.codeIntelligence.managedInstall.statusUnsupported',
      'Managed build unavailable'
    ),
    'needs-first-install': translate(
      'settings.codeIntelligence.managedInstall.statusNotInstalled',
      'Not installed'
    ),
    installing: translate(
      'settings.codeIntelligence.managedInstall.statusInstalling',
      'Installing {{value0}}',
      { value0: controller.event?.version ?? '' }
    ),
    failed: translate('settings.codeIntelligence.managedInstall.statusFailed', 'Install failed'),
    canceled: translate(
      'settings.codeIntelligence.managedInstall.statusCanceled',
      'Install canceled'
    ),
    'update-available': translate(
      'settings.codeIntelligence.managedInstall.statusUpdateAvailable',
      'Update available ({{value0}})',
      { value0: controller.state?.latestEntry?.version ?? '' }
    ),
    active: translate('settings.codeIntelligence.managedInstall.statusActive', 'Active')
  }[view.status]

  const lastOfflineFile = getLastOfflineManagedArchive(executionHostId, tool)
  const entry = controller.state?.latestEntry ?? null
  const reloadOfflineButton = lastOfflineFile ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="gap-1.5"
      disabled={controller.busy}
      title={lastOfflineFile}
      onClick={() => void runInstall({ type: 'client-file', filePath: lastOfflineFile })}
    >
      <FileUp className="size-3.5" />
      {translate('settings.codeIntelligence.managedInstall.reloadOfflineFile', 'Reload {{value0}}', {
        value0: lastOfflineFile.split(/[\\/]/).pop() ?? lastOfflineFile
      })}
    </Button>
  ) : null

  return (
    <div className="rounded-md">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent/50"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">
            {label}
            {controller.state?.activeVersion ? ` · ${controller.state.activeVersion}` : ''}
          </span>
          <span
            className={`block truncate text-[11px] ${
              view.status === 'failed' || view.status === 'unsupported'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
            }`}
          >
            {statusText}
          </span>
        </span>
        {controller.busy && view.status !== 'installing' && view.status !== 'failed' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : view.status === 'failed' || view.status === 'unsupported' ? (
          <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : view.status === 'active' ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-status-success" />
        ) : (
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <div className="space-y-2 px-1.5 pb-1.5 pt-1">
          {controller.busy && view.status !== 'installing' && view.status !== 'failed' ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {translate('settings.codeIntelligence.managedInstall.workingLabel', 'Working…')}
            </div>
          ) : null}
          {rollbackFailure ? (
            <div
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 p-1.5 text-[11px] text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{rollbackFailure}</span>
            </div>
          ) : null}
          {view.status === 'unsupported' ? (
            <UnsupportedHostBody
              reason={controller.state?.unsupportedReason ?? null}
              runtimeCapabilityUnsupported={controller.runtimeCapabilityUnsupported}
            />
          ) : null}
          {view.status === 'installing' ? (
            <div className="space-y-1.5">
              {view.progressPercent !== null ? <Progress value={view.progressPercent} /> : null}
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {controller.event && PHASE_LABELS[controller.event.phase]
                    ? translate(
                        PHASE_LABELS[controller.event.phase].key,
                        PHASE_LABELS[controller.event.phase].fallback
                      )
                    : statusText}
                  {view.progressPercent !== null ? ` · ${view.progressPercent}%` : ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-5 px-1.5"
                  onClick={() => void controller.cancel()}
                >
                  {translate('settings.codeIntelligence.managedInstall.cancelInstall', 'Cancel')}
                </Button>
              </div>
              {view.safeActiveVersion ? <SafeVersionNotice version={view.safeActiveVersion} /> : null}
            </div>
          ) : null}
          {view.status === 'failed' ? (
            <div className="space-y-2">
              {view.safeActiveVersion ? <SafeVersionNotice version={view.safeActiveVersion} /> : null}
              {entry ? (
                <ManagedLanguageServerRecoveryDetails
                  entry={entry}
                  hostLabel={hostLabel}
                  downloadsPath={downloadsPath}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="gap-1.5"
                  disabled={controller.busy}
                  onClick={() => void runInstall({ type: 'host-download' })}
                >
                  <RefreshCw className="size-3.5" />
                  {translate('settings.codeIntelligence.managedInstall.retryDownload', 'Retry download')}
                </Button>
                {hostKind !== 'runtime' ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="gap-1.5"
                      disabled={controller.busy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileUp className="size-3.5" />
                      {translate('settings.codeIntelligence.managedInstall.selectOfflineFile', 'Select downloaded file')}
                    </Button>
                    {reloadOfflineButton}
                  </>
                ) : null}
              </div>
              {view.failureMessage ? (
                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    {translate('settings.codeIntelligence.managedInstall.detailsLabel', 'Staging details')}
                  </summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 font-mono text-[10px] scrollbar-sleek">
                    {view.failureMessage}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
          {view.status === 'canceled' && lastOfflineFile && hostKind !== 'runtime'
            ? reloadOfflineButton
            : null}
          {/* 'canceled' keeps the terminal event visible but must not strand the
              first-consent entry or the update retry (#21 review). */}
          {controller.state?.activeVersion === null &&
          (view.status === 'needs-first-install' || view.status === 'canceled') ? (
            needsFirstManagedInstallConsent(controller.state) ? (
              <Button
                type="button"
                size="xs"
                className="gap-1.5"
                disabled={controller.busy || !entry}
                onClick={() => setConsentOpen(true)}
              >
                <Download className="size-3.5" />
                {translate('settings.codeIntelligence.managedInstall.installAction', 'Install')}
              </Button>
            ) : (
              // Something is installed but nothing active: re-activate directly.
              <Button
                type="button"
                size="xs"
                className="gap-1.5"
                disabled={controller.busy}
                onClick={() => void runInstall({ type: 'host-download' })}
              >
                <Download className="size-3.5" />
                {translate('settings.codeIntelligence.managedInstall.installAction', 'Install')}
              </Button>
            )
          ) : null}
          {(view.status === 'update-available' ||
            (view.status === 'canceled' && controller.state?.activeVersion !== null)) ? (
            <Button
              type="button"
              size="xs"
              className="gap-1.5"
              disabled={controller.busy}
              onClick={() => void runInstall({ type: 'host-download' })}
            >
              <Download className="size-3.5" />
              {translate('settings.codeIntelligence.managedInstall.updateAction', 'Update')}
            </Button>
          ) : null}
          {controller.state?.activeVersion && controller.state.rollbackVersion ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1.5"
              disabled={controller.busy}
              onClick={() => void handleRollback()}
            >
              <RotateCcw className="size-3.5" />
              {translate('settings.codeIntelligence.managedInstall.rollbackAction', 'Roll back to {{value0}}', {
                value0: controller.state.rollbackVersion
              })}
            </Button>
          ) : null}
          {controller.state?.activeVersion &&
          toolScopes.some((scope) => scope.serverSource.type !== 'managed') ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="gap-1.5"
              onClick={() => void handleUseManaged()}
            >
              <CheckCircle2 className="size-3.5" />
              {translate('settings.codeIntelligence.managedInstall.useManaged', 'Use managed server for {{value0}} scopes here', {
                value0: label
              })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={MANAGED_ARCHIVE_ACCEPT}
        aria-hidden
        tabIndex={-1}
        onChange={(change) => {
          const file = change.target.files?.[0]
          change.target.value = ''
          if (file) {
            void runInstall({
              type: 'client-file',
              filePath: window.api.codeIntelligence.localFilePathForFile(file)
            })
          }
        }}
      />
      {consentOpen && controller.state ? (
        <ManagedLanguageServerConsentDialog
          open={consentOpen}
          onOpenChange={setConsentOpen}
          state={controller.state}
          executionHostId={executionHostId}
          tool={tool}
          busy={controller.busy}
          onConfirm={(route) => {
            setConsentOpen(false)
            void runInstall(route)
          }}
        />
      ) : null}
    </div>
  )
}
