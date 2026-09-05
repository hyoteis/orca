import { useMemo, useRef, useState } from 'react'
import { ChevronDown, FileText, GitCompare, Globe, Search, Smartphone, X } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ShellIcon } from './shell-icons'
import {
  filterOpenTabsOverviewGroups,
  type OpenTabsOverviewKind,
  type OpenTabsOverviewRow
} from './open-tabs-overview-model'
import { activateOpenTabSearchResult } from './open-tab-selection-routing'
import { useOpenTabsOverview } from './use-open-tabs-overview'

const GROUP_LABELS: Record<OpenTabsOverviewKind, () => string> = {
  agent: () => translate('auto.components.tab.bar.OpenTabsOverviewButton.3a8f01bd', 'Agent'),
  shell: () => translate('auto.components.tab.bar.OpenTabsOverviewButton.5c2e94fa', 'Shell'),
  file: () => translate('auto.components.tab.bar.OpenTabsOverviewButton.9d4b76ce', 'Files'),
  browser: () => translate('auto.components.tab.bar.OpenTabsOverviewButton.e6f18022', 'Browser'),
  simulator: () => translate('auto.components.tab.bar.OpenTabsOverviewButton.2b7c53d9', 'Simulator')
}

function RowLeadIcon({ row }: { row: OpenTabsOverviewRow }): React.JSX.Element {
  if (row.agent) {
    return <AgentIcon agent={row.agent} size={12} />
  }
  const contentType = row.activate.contentType
  if (contentType === 'terminal') {
    // Same badge as the tab strip: PowerShell/CMD/Git Bash/WSL brand tiles,
    // generic terminal elsewhere.
    return <ShellIcon shell={row.shell} size={12} />
  }
  const icon =
    contentType === 'browser' ? (
      <Globe className="size-3.5" aria-hidden="true" />
    ) : contentType === 'simulator' ? (
      <Smartphone className="size-3.5" aria-hidden="true" />
    ) : contentType === 'editor' ? (
      <FileText className="size-3.5" aria-hidden="true" />
    ) : (
      <GitCompare className="size-3.5" aria-hidden="true" />
    )
  return <span className="text-muted-foreground">{icon}</span>
}

export function OpenTabsOverviewButton({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [switchError, setSwitchError] = useState<string | null>(null)
  // null = follow the flat row order; set on arrow keys only, like the omnibox.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { groups } = useOpenTabsOverview({ enabled: open, worktreeId })
  const visibleGroups = useMemo(() => filterOpenTabsOverviewGroups(groups, query), [groups, query])
  const flatRows = useMemo(() => visibleGroups.flatMap((group) => group.rows), [visibleGroups])
  const selectedIndex = selectedKey ? flatRows.findIndex((row) => row.key === selectedKey) : -1
  const selectedRow = selectedIndex >= 0 ? flatRows[selectedIndex] : null

  const activateRow = (row: OpenTabsOverviewRow): void => {
    const outcome = activateOpenTabSearchResult(row.activate)
    if (outcome.status === 'failed') {
      setSwitchError(outcome.message)
      return
    }
    outcome.focus?.()
    setOpen(false)
  }

  const closeRow = (row: OpenTabsOverviewRow): void => {
    const { closeTarget } = row
    if (closeTarget.type === 'unified') {
      useAppStore.getState().closeUnifiedTab(closeTarget.tabId)
    } else {
      useAppStore.getState().closeBrowserPage(closeTarget.pageId)
    }
    setSwitchError(null)
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') {
      return
    }
    if (flatRows.length === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter') {
      activateRow(selectedRow ?? flatRows[0])
      return
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex =
      selectedIndex < 0
        ? event.key === 'ArrowDown'
          ? 0
          : flatRows.length - 1
        : (selectedIndex + delta + flatRows.length) % flatRows.length
    setSelectedKey(flatRows[nextIndex].key)
    setSwitchError(null)
  }

  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
          setSwitchError(null)
          setSelectedKey(null)
          requestAnimationFrame(() => inputRef.current?.focus())
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={translate('auto.components.tab.bar.OpenTabsOverviewButton.c41f2a90', 'Open tabs')}
            aria-expanded={open}
            data-testid="open-tabs-overview-trigger"
            className="my-auto flex h-7 shrink-0 items-center rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronDown className="size-3.5" />
          </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.tab.bar.OpenTabsOverviewButton.c41f2a90', 'Open tabs')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-testid="open-tabs-overview-popover"
        className="w-[360px] max-w-[calc(100vw-1rem)] rounded-[11px] border-border/80 p-0 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedKey(null)
              setSwitchError(null)
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={translate(
              'auto.components.tab.bar.OpenTabsOverviewButton.b1d3e552',
              'Search tabs'
            )}
            aria-label={translate(
              'auto.components.tab.bar.OpenTabsOverviewButton.b1d3e552',
              'Search tabs'
            )}
            className="h-6 border-0 bg-transparent px-0 text-xs font-normal shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        {switchError ? (
          <p role="status" className="px-3 pt-2 text-[11px] text-destructive">
            {switchError}
          </p>
        ) : null}
        <div className="scrollbar-sleek max-h-[430px] overflow-y-auto p-1" role="listbox">
          {flatRows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {translate('auto.components.tab.bar.OpenTabsOverviewButton.7e9c31af', 'No matching tabs')}
            </p>
          ) : (
            visibleGroups.map((group) => (
              <div key={group.kind}>
                <div className="flex items-center justify-between px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{GROUP_LABELS[group.kind]()}</span>
                  <span className="tabular-nums opacity-80">{group.rows.length}</span>
                </div>
                {group.rows.map((row) => {
                  const selected = row.key === selectedRow?.key
                  return (
                    <div
                      key={row.key}
                      role="option"
                      aria-selected={row.isCurrent}
                      className={[
                        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs',
                        row.isCurrent
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground',
                        selected ? 'outline outline-1 outline-accent' : ''
                      ].join(' ')}
                      onClick={() => activateRow(row)}
                    >
                      <span className="flex w-4 shrink-0 items-center justify-center">
                        <RowLeadIcon row={row} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      {row.secondaryText ? (
                        <span className="min-w-0 max-w-[42%] shrink-1 truncate text-[10.5px] text-muted-foreground">
                          {row.secondaryText}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        aria-label={translate(
                          'auto.components.tab.bar.OpenTabsOverviewButton.8a5c44e1',
                          'Close tab'
                        )}
                        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation()
                          closeRow(row)
                        }}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
