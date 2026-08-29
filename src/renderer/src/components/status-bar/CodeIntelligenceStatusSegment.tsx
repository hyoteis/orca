import React, { useMemo, useState } from 'react'
import { AlertTriangle, Braces, CheckCircle2, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { useAppStore } from '@/store'
import { useWorktreeMap } from '@/store/selectors'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  countCodeIntelligenceScopeFolders,
  getCodeIntelligenceMemberDisplayPath,
  getStatusBarCodeIntelligenceScopes
} from './code-intelligence-status-scopes'

type Props = { iconOnly: boolean }

export function CodeIntelligenceStatusSegment({ iconOnly }: Props): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const repos = useAppStore((state) => state.repos)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const openModal = useAppStore((state) => state.openModal)
  const [open, setOpen] = useState(false)
  const worktreeMap = useWorktreeMap()
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
  const activeRepo = activeWorktree
    ? repos.find((repo) => repo.id === activeWorktree.repoId)
    : undefined
  const executionHostId = activeWorktree
    ? getWorktreeExecutionHostId(activeWorktree, activeRepo)
    : null
  const scopes = useMemo(
    () => getStatusBarCodeIntelligenceScopes({ settings, activeWorktreeId, executionHostId }),
    [activeWorktreeId, executionHostId, settings]
  )
  if (scopes.length === 0) {
    return null
  }
  const folderCount = countCodeIntelligenceScopeFolders(scopes)
  const setupStatus = scopes.find((scope) => scope.language === 'cpp')?.setupStatus
  const healthLabel =
    setupStatus?.state === 'ready'
      ? translate('settings.codeIntelligence.healthReady', 'Ready')
      : setupStatus?.state === 'limited'
        ? translate('settings.codeIntelligence.healthLimited', 'Limited')
        : setupStatus?.state === 'error'
          ? translate('settings.codeIntelligence.healthError', 'Error')
          : translate('settings.codeIntelligence.healthUnknown', 'Status unavailable')
  const statusMessage =
    setupStatus?.state === 'limited' && setupStatus.mode === 'basic'
      ? translate(
          'settings.codeIntelligence.basicLimitedWarning',
          'BASIC indexing infers include paths and may miss SDK headers, generated files, or build macros.'
        )
      : setupStatus?.message
  const healthColor =
    setupStatus?.state === 'ready'
      ? 'text-status-success'
      : setupStatus?.state === 'limited'
        ? 'text-amber-500'
        : setupStatus?.state === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground'
  const projectName = activeRepo?.displayName ?? scopes[0].name
  const tooltip = translate(
    'settings.codeIntelligence.statusSummary',
    'Code intelligence: {{value0}} folders',
    { value0: folderCount }
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent/70 hover:text-foreground ${healthColor}`}
              aria-label={tooltip}
            >
              <Braces className="size-3" />
              {!iconOnly ? (
                <span className="text-[11px] font-medium tabular-nums">{folderCount}</span>
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {tooltip}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SelectedTextCopyMenu>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
              <Braces className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {translate('settings.codeIntelligence.statusTitle', 'Code intelligence folders')}
              </span>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">{folderCount}</span>
          </div>
          <div className="border-b border-border/60 px-3 py-2">
            <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {scopes[0].workspaceRoot}
            </div>
          </div>
          <div className="border-b border-border/60 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className={`flex items-center gap-1.5 text-xs font-medium ${healthColor}`}>
                {setupStatus?.state === 'ready' ? (
                  <CheckCircle2 className="size-3.5" />
                ) : (
                  <AlertTriangle className="size-3.5" />
                )}
                <span>{healthLabel}</span>
              </div>
              {setupStatus ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  {setupStatus.mode}
                </span>
              ) : null}
            </div>
            {setupStatus ? (
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span>
                  {translate(
                    'settings.codeIntelligence.compileCommandCount',
                    '{{value0}} compile commands',
                    { value0: setupStatus.compileCommandCount ?? 0 }
                  )}
                </span>
                <span className="text-right">
                  {new Date(setupStatus.generatedAt).toLocaleString()}
                </span>
              </div>
            ) : null}
            {statusMessage ? (
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {statusMessage}
              </p>
            ) : null}
          </div>
          <div className="max-h-[24rem] overflow-y-auto p-1.5 scrollbar-sleek">
            {scopes.map((scope) => (
              <section key={scope.id} className="rounded-md px-1.5 py-1.5">
                <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
                  <span>{scope.language === 'cpp' ? 'C++' : 'Python'}</span>
                  <span>{scope.members.length}</span>
                </div>
                <div className="space-y-0.5">
                  {scope.members.map((member) => {
                    const displayPath = getCodeIntelligenceMemberDisplayPath(scope, member)
                    return (
                      <div
                        key={member.path}
                        className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-foreground hover:bg-accent/50"
                        title={displayPath}
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                          {member.path}
                        </span>
                        {!member.visibleResults ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {translate(
                              'settings.codeIntelligence.statusResultsHidden',
                              'Results hidden'
                            )}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
            {setupStatus?.compileCommandsDir ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void window.api.shell.openPath(setupStatus.compileCommandsDir!)}
              >
                <FolderOpen className="size-3.5" />
                {translate('settings.codeIntelligence.openDatabase', 'Open database')}
              </Button>
            ) : null}
            {activeRepo ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setOpen(false)
                  openModal('code-intelligence-cpp-setup', { repoId: activeRepo.id })
                }}
              >
                <RefreshCw className="size-3.5" />
                {translate('settings.codeIntelligence.reconfigure', 'Reconfigure')}
              </Button>
            ) : null}
          </div>
        </SelectedTextCopyMenu>
      </PopoverContent>
    </Popover>
  )
}
