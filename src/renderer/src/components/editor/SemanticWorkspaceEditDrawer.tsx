import { useStore } from 'zustand'
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  FilePlus2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { WorkspaceEditBlockReason } from '../../../../shared/language-server-workspace-edit'
import {
  applySemanticEditDrawerReview,
  closeSemanticEditDrawer,
  refreshSemanticEditDrawer,
  semanticWorkspaceEditDrawerStore,
  undoSemanticEditDrawerCompletion,
  type SemanticEditDrawerPhase
} from '@/lib/language-server/semantic-workspace-edit-drawer-store'
import type { DrawerSession } from '@/lib/language-server/semantic-workspace-edit-drawer-store'
import { buildWorkspaceEditStepPreviews } from '@/lib/language-server/workspace-edit-step-preview'
import { SemanticWorkspaceEditRecoveryDialog } from './SemanticWorkspaceEditRecoveryDialog'

const BLOCK_REASON_LABELS: Record<WorkspaceEditBlockReason, { key: string; fallback: string }> = {
  'out-of-scope': {
    key: 'settings.codeIntelligence.semanticEditBlock.outOfScope',
    fallback: 'Outside the consented scope'
  },
  'host-mismatch': {
    key: 'settings.codeIntelligence.semanticEditBlock.hostMismatch',
    fallback: 'Belongs to a different execution host'
  },
  'non-file-uri': {
    key: 'settings.codeIntelligence.semanticEditBlock.nonFileUri',
    fallback: 'Not a file URI'
  },
  'stale-version': {
    key: 'settings.codeIntelligence.semanticEditBlock.staleVersion',
    fallback: 'Document changed since the edit was computed'
  },
  'dirty-editor': {
    key: 'settings.codeIntelligence.semanticEditBlock.dirtyEditor',
    fallback: 'Unsaved changes in an open editor'
  },
  'external-change': {
    key: 'settings.codeIntelligence.semanticEditBlock.externalChange',
    fallback: 'File changed on disk'
  },
  'existing-target': {
    key: 'settings.codeIntelligence.semanticEditBlock.existingTarget',
    fallback: 'Target already exists'
  },
  'missing-target': {
    key: 'settings.codeIntelligence.semanticEditBlock.missingTarget',
    fallback: 'Target is missing'
  },
  'edit-application': {
    key: 'settings.codeIntelligence.semanticEditBlock.editApplication',
    fallback: 'Edit positions no longer match the file'
  },
  'unsupported-target': {
    key: 'settings.codeIntelligence.semanticEditBlock.unsupportedTarget',
    fallback: 'Unsupported target type'
  }
}

/**
 * #38 bottom drawer: all-or-nothing review (file list + diffs + Host/scope
 * disclosure), conflict refresh, apply progress, completion with session undo.
 * Only an incomplete rollback escalates to the focused recovery dialog.
 */
export function SemanticWorkspaceEditDrawer(): React.JSX.Element | null {
  const session = useStore(semanticWorkspaceEditDrawerStore, (state) => state.session)
  const phase = useStore(semanticWorkspaceEditDrawerStore, (state) => state.phase)
  if (!session || !phase) {
    return null
  }
  const busy =
    phase.kind === 'planning' || phase.kind === 'applying' || phase.kind === 'undoing'
  const steps =
    phase.kind === 'review' || phase.kind === 'applying'
      ? phase.steps
      : phase.kind === 'done' && phase.outcome.status === 'committed'
        ? phase.outcome.undo.steps
        : []
  const previews = buildWorkspaceEditStepPreviews({
    steps,
    workspaceRoot: session.scope.workspaceRoot
  })

  return (
    <Sheet open onOpenChange={(open) => (!open ? closeSemanticEditDrawer() : undefined)}>
      <SheetContent
        side="bottom"
        className="scrollbar-sleek max-h-[60vh] gap-0 overflow-y-auto sm:max-w-none"
        showCloseButton={!busy}
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="flex items-center gap-2 text-sm">
            {phase.kind === 'done' && phase.outcome.status === 'committed' ? (
              <CheckCircle2 className="size-4 shrink-0 text-status-success" />
            ) : phase.kind === 'conflicts' || phase.kind === 'recovery' ? (
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : null}
            {translate('settings.codeIntelligence.semanticEditDrawerTitle', 'Review workspace edit')}
            <span className="font-normal text-muted-foreground">
              {translate(
                'settings.codeIntelligence.semanticEditDrawerFiles',
                '{{value0}} file operations',
                { value0: String(previews.length) }
              )}
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            {translate(
              'settings.codeIntelligence.semanticEditDrawerAllOrNothing',
              'All files apply together or nothing changes'
            )}
          </SheetDescription>
          <HostScopeDisclosure session={session} />
        </SheetHeader>
        <DrawerBody phase={phase} previews={previews} />
        {phase.kind === 'recovery' ? (
          <SemanticWorkspaceEditRecoveryDialog
            outcome={phase.outcome}
            workspaceRoot={session.scope.workspaceRoot}
            onClose={closeSemanticEditDrawer}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DrawerBody({
  phase,
  previews
}: {
  phase: SemanticEditDrawerPhase
  previews: ReturnType<typeof buildWorkspaceEditStepPreviews>
}): React.JSX.Element | null {
  if (phase.kind === 'planning') {
    return <BusyLabel labelKey="semanticEditDrawerPlanning" fallback="Checking targets…" />
  }
  if (phase.kind === 'undoing') {
    return <BusyLabel labelKey="semanticEditDrawerUndoing" fallback="Undoing…" />
  }
  if (phase.kind === 'review' || phase.kind === 'applying') {
    return (
      <div className="space-y-2 px-4 pb-2">
        {phase.kind === 'applying' ? (
          <BusyLabel labelKey="semanticEditDrawerApplying" fallback="Applying…" />
        ) : null}
        <ul className="space-y-0.5" aria-busy={phase.kind === 'applying'}>
          {previews.map((preview) => (
            <li key={`${preview.type}:${preview.path}`}>
              <StepRow preview={preview} muted={phase.kind === 'applying'} />
            </li>
          ))}
        </ul>
        {phase.kind === 'review' ? <DrawerActions kind="review" /> : null}
      </div>
    )
  }
  if (phase.kind === 'conflicts') {
    return (
      <div className="space-y-2 px-4 pb-2">
        <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {translate(
            'settings.codeIntelligence.semanticEditDrawerConflicts',
            'Blocked targets — resolve these files, then re-check'
          )}
        </div>
        <ul className="space-y-0.5">
          {phase.blocks.map((block) => (
            <li
              key={`${block.reason}:${block.hostPath}`}
              className="flex items-baseline gap-1.5 rounded bg-amber-500/10 px-1.5 py-1 text-[11px]"
            >
              <span className="shrink-0 text-amber-600 dark:text-amber-400">
                {translate(
                  BLOCK_REASON_LABELS[block.reason].key,
                  BLOCK_REASON_LABELS[block.reason].fallback
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono" title={block.hostPath}>
                {block.hostPath}
              </span>
              {block.detail ? (
                <span className="shrink-0 text-muted-foreground">{block.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <DrawerActions kind="conflicts" />
      </div>
    )
  }
  if (phase.kind === 'done') {
    const { outcome } = phase
    if (outcome.status === 'committed') {
      return (
        <div className="space-y-2 px-4 pb-2">
          <div className="text-xs text-status-success">
            {phase.undone
              ? translate(
                  'settings.codeIntelligence.semanticEditDrawerUndone',
                  'Undone — files restored'
                )
              : translate(
                  'settings.codeIntelligence.semanticEditDrawerApplied',
                  'Applied {{value0}} file operation(s)',
                  { value0: String(outcome.steps.length) }
                )}
          </div>
          <DrawerActions kind="done" />
        </div>
      )
    }
    return (
      <div className="space-y-2 px-4 pb-2">
        <div className="text-xs text-amber-600 dark:text-amber-400">
          {translate(
            'settings.codeIntelligence.semanticEditDrawerFailedRestored',
            'Edit failed — all changes were restored'
          )}
        </div>
        <pre className="scrollbar-sleek max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 font-mono text-[10px]">
          {outcome.error}
        </pre>
        <DrawerActions kind="closed" />
      </div>
    )
  }
  return null
}

function StepRow({
  preview,
  muted
}: {
  preview: ReturnType<typeof buildWorkspaceEditStepPreviews>[number]
  muted: boolean
}): React.JSX.Element {
  const icon = {
    write: <Pencil className="size-3 shrink-0" />,
    create: <FilePlus2 className="size-3 shrink-0" />,
    rename: <ArrowLeftRight className="size-3 shrink-0" />,
    delete: <Trash2 className="size-3 shrink-0" />
  }[preview.type]
  const diffBody = preview.diff && preview.diff.length > 0 && (
    <pre className="scrollbar-sleek mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-1.5 font-mono text-[10px] leading-4">
      {preview.diff.map((row, index) => (
        <div
          key={index}
          className={
            row.kind === 'add'
              ? 'bg-status-success-background text-status-success'
              : row.kind === 'remove'
                ? 'bg-destructive/10 text-destructive'
                : 'text-muted-foreground'
          }
        >
          {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '} {row.text}
        </div>
      ))}
    </pre>
  )
  const summary = (
    <summary
      className={`flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-accent/50 ${
        muted ? 'opacity-70' : ''
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono" title={preview.nextPath ?? preview.path}>
        {preview.path}
        {preview.nextPath ? ` → ${preview.nextPath}` : ''}
      </span>
      {preview.addLines > 0 || preview.removeLines > 0 ? (
        <span className="shrink-0 font-normal">
          <span className="text-status-success">+{preview.addLines}</span>{' '}
          <span className="text-destructive">−{preview.removeLines}</span>
        </span>
      ) : null}
    </summary>
  )
  return diffBody ? <details>{summary}{diffBody}</details> : <div>{summary}</div>
}

function DrawerActions({ kind }: { kind: 'review' | 'conflicts' | 'done' | 'closed' }): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2 pt-1">
      {kind === 'review' ? (
        <>
          <Button type="button" variant="outline" size="sm" onClick={closeSemanticEditDrawer}>
            {translate('settings.codeIntelligence.semanticEditDrawerCancel', 'Cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => void applySemanticEditDrawerReview()}>
            {translate('settings.codeIntelligence.semanticEditDrawerApply', 'Apply')}
          </Button>
        </>
      ) : null}
      {kind === 'conflicts' ? (
        <>
          <Button type="button" variant="outline" size="sm" onClick={closeSemanticEditDrawer}>
            {translate('settings.codeIntelligence.semanticEditDrawerCancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => void refreshSemanticEditDrawer()}
          >
            <RefreshCw className="size-3.5" />
            {translate('settings.codeIntelligence.semanticEditDrawerRefresh', 'Re-check')}
          </Button>
        </>
      ) : null}
      {kind === 'done' ? (
        <>
          <Button type="button" variant="outline" size="sm" onClick={closeSemanticEditDrawer}>
            {translate('settings.codeIntelligence.semanticEditDrawerClose', 'Close')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => void undoSemanticEditDrawerCompletion()}
          >
            <Undo2 className="size-3.5" />
            {translate('settings.codeIntelligence.semanticEditDrawerUndo', 'Undo')}
          </Button>
        </>
      ) : null}
      {kind === 'closed' ? (
        <Button type="button" size="sm" onClick={closeSemanticEditDrawer}>
          {translate('settings.codeIntelligence.semanticEditDrawerClose', 'Close')}
        </Button>
      ) : null}
    </div>
  )
}

function HostScopeDisclosure({ session }: { session: DrawerSession }): React.JSX.Element {
  return (
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none">
        {translate('settings.codeIntelligence.semanticEditDrawerDetails', 'Host & scope')}
      </summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1">
        <dt className="shrink-0">
          {translate('settings.codeIntelligence.semanticEditDrawerHost', 'Execution host')}
        </dt>
        <dd className="truncate">{getExecutionHostLabel(session.operationHostId)}</dd>
        <dt className="shrink-0">
          {translate('settings.codeIntelligence.semanticEditDrawerScope', 'Scope')}
        </dt>
        <dd className="truncate">{session.scope.name}</dd>
        <dt className="shrink-0">
          {translate('settings.codeIntelligence.semanticEditDrawerRoot', 'Workspace root')}
        </dt>
        <dd className="truncate font-mono">{session.scope.workspaceRoot}</dd>
      </dl>
    </details>
  )
}

function BusyLabel({
  labelKey,
  fallback
}: {
  labelKey: string
  fallback: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-4 pb-2 text-[11px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {translate(`settings.codeIntelligence.${labelKey}`, fallback)}
    </div>
  )
}
