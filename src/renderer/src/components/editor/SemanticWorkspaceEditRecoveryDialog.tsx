import { useState } from 'react'
import { AlertTriangle, Check, ClipboardCopy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type {
  WorkspaceEditRecoveryArtifact,
  WorkspaceEditTransactionOutcome
} from '../../../../shared/language-server-workspace-edit'
import { displayWorkspaceEditPath } from '@/lib/language-server/workspace-edit-step-preview'

const ENTRY_LABELS = {
  content: {
    key: 'settings.codeIntelligence.semanticEditRecoveryEntryContent',
    fallback: 'Restore file content'
  },
  delete: {
    key: 'settings.codeIntelligence.semanticEditRecoveryEntryDelete',
    fallback: 'Delete created file'
  },
  rename: {
    key: 'settings.codeIntelligence.semanticEditRecoveryEntryRename',
    fallback: 'Move file back'
  }
} as const

/**
 * #23/#38 focused escalation: shown only when a transaction failed AND its
 * rollback did not restore everything. Lists restored vs unrestored paths and
 * the recovery copies (preimages) needed to finish restoring by hand.
 */
export function SemanticWorkspaceEditRecoveryDialog({
  outcome,
  workspaceRoot,
  onClose
}: {
  outcome: Extract<WorkspaceEditTransactionOutcome, { status: 'failed' }>
  workspaceRoot: string
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const restored = outcome.steps.filter((step) => step.status === 'rolled-back')
  const unrestored = outcome.steps.filter((step) => step.status === 'committed')

  const copyArtifact = async (): Promise<void> => {
    await navigator.clipboard.writeText(formatRecoveryArtifact(outcome.recovery))
    setCopied(true)
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="scrollbar-sleek max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {translate(
              'settings.codeIntelligence.semanticEditRecoveryTitle',
              'Some changes could not be rolled back'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'settings.codeIntelligence.semanticEditRecoveryHint',
              'The edit failed and automatic rollback stopped early. Finish restoring with the recovery copies below.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2 font-mono text-[11px] break-words">
            {outcome.error}
          </div>
          <PathList
            label={translate('settings.codeIntelligence.semanticEditRecoveryRestored', 'Restored')}
            paths={restored.map((step) => displayWorkspaceEditPath(step.hostPath, workspaceRoot))}
            tone="ok"
          />
          <PathList
            label={translate(
              'settings.codeIntelligence.semanticEditRecoveryUnrestored',
              'Not restored'
            )}
            paths={unrestored.map((step) => displayWorkspaceEditPath(step.hostPath, workspaceRoot))}
            tone="bad"
          />
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              {translate(
                'settings.codeIntelligence.semanticEditRecoveryCopies',
                'Recovery copies'
              )}
            </div>
            <ol className="space-y-1">
              {outcome.recovery.entries.map((entry, index) => (
                <li
                  key={index}
                  className="rounded bg-muted/60 p-1.5 font-mono text-[10px] break-all"
                >
                  {translate(ENTRY_LABELS[entry.kind].key, ENTRY_LABELS[entry.kind].fallback)}
                  {' · '}
                  {entry.kind === 'rename'
                    ? `${displayWorkspaceEditPath(entry.fromPath, workspaceRoot)} → ${displayWorkspaceEditPath(entry.toPath, workspaceRoot)}`
                    : displayWorkspaceEditPath(entry.hostPath, workspaceRoot)}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyArtifact()}>
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <ClipboardCopy className="size-3.5" />
            )}
            {copied
              ? translate('settings.codeIntelligence.semanticEditRecoveryCopied', 'Copied')
              : translate(
                  'settings.codeIntelligence.semanticEditRecoveryCopy',
                  'Copy recovery details'
                )}
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            {translate('settings.codeIntelligence.semanticEditDrawerClose', 'Close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PathList({
  label,
  paths,
  tone
}: {
  label: string
  paths: readonly string[]
  tone: 'ok' | 'bad'
}): React.JSX.Element | null {
  if (paths.length === 0) {
    return null
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      <ul
        className={`space-y-0.5 font-mono text-[11px] ${
          tone === 'bad' ? 'text-amber-600 dark:text-amber-400' : 'text-status-success'
        }`}
      >
        {paths.map((path) => (
          <li key={path} className="break-all">
            {path}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatRecoveryArtifact(artifact: WorkspaceEditRecoveryArtifact): string {
  return JSON.stringify(artifact, null, 2)
}
