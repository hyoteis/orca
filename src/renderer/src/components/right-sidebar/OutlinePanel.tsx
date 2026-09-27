import React, { useMemo, useState } from 'react'
import {
  ArrowDownUp,
  Braces,
  CircleOff,
  LayoutGrid,
  ListFilter,
  ListTree,
  Loader2,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  enclosingOutlineRowKey,
  filterOutlineRows,
  sortOutlineRows,
  type OutlineSortMode
} from './outline-model'
import { useOutlineSymbols } from './use-outline-symbols'
import { OutlineTree } from './OutlineTree'
import { translate } from '@/i18n/i18n'

type StatusBlock = {
  icon: LucideIcon
  title: string
  subtitle?: string
  action?: React.ReactNode
}

function OutlineEmptyState({
  icon: Icon,
  title,
  subtitle,
  action
}: StatusBlock): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-5 py-8 text-center">
      <Icon className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-xs text-foreground">{title}</p>
      {subtitle ? <p className="text-[11px] text-muted-foreground">{subtitle}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** Same copy as the empty state, but compact and pinned below heuristic rows
 * (#103) — the status message stays honest while the tree stays usable. */
function OutlineStatusFooter({ block }: { block: StatusBlock }): React.JSX.Element {
  return (
    <div
      data-testid="outline-status-footer"
      className="flex flex-col items-center gap-0.5 border-t border-border px-2 py-1.5 text-center"
    >
      <p className="text-[11px] text-foreground">{block.title}</p>
      {block.subtitle ? (
        <p className="text-[11px] text-muted-foreground">{block.subtitle}</p>
      ) : null}
      {block.action ? <div className="mt-1">{block.action}</div> : null}
    </div>
  )
}

/** Stable empty reference so the projection memo deps hold across non-ready renders. */
const EMPTY_ROWS: readonly never[] = []

// Shared header-control base (segmented sort + filter toggle), prototype .ctl.
const HEADER_CONTROL_CLASS =
  'grid h-[22px] place-items-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** Right-sidebar Outline tab (#99): symbol tree of the active editor file.
 * #102 adds the interactions: filter, sort, cursor-follow, collapse memory,
 * live refresh, and the unready retry state. #103 adds the heuristic tier:
 * approximate rows plus badge when no language server can answer. */
export function OutlinePanel(): React.JSX.Element {
  const { state, fileName, indexing, reveal, cursorLine, collapsedKeys, toggleCollapsed, retry } =
    useOutlineSymbols()
  const [sortMode, setSortMode] = useState<OutlineSortMode>('position')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')

  const heuristicRows =
    state.status === 'unready' ? (state.heuristicRows ?? EMPTY_ROWS) : EMPTY_ROWS
  const rows = state.status === 'ready' ? state.rows : heuristicRows
  // Tier-based, not row-based: an empty extraction still marks the tier (#98
  // story 12); undefined (document not mounted) shows the plain status only.
  const approximate = state.status === 'unready' && heuristicRows !== EMPTY_ROWS
  const filtering = filterQuery.trim().length > 0
  const visibleRows = useMemo(
    () => filterOutlineRows(sortOutlineRows(rows, sortMode), filterQuery),
    [rows, sortMode, filterQuery]
  )
  const cursorRowKey = cursorLine === null ? null : enclosingOutlineRowKey(visibleRows, cursorLine)

  const statusBlock: StatusBlock | null = useMemo(() => {
    if (state.status === 'unready') {
      // Single face for every failure (spec-b §0): dead session, failed query —
      // the message names the remedy, retry re-queries.
      return {
        icon: Braces,
        title: translate(
          'auto.components.right.sidebar.OutlinePanel.a54eff7728',
          'No symbols available'
        ),
        subtitle:
          state.message ??
          translate(
            'auto.components.right.sidebar.OutlinePanel.70a1c94357',
            'No language server connected — symbols are approximate and jumps are line-level'
          ),
        action: (
          <Button type="button" size="xs" variant="outline" onClick={retry}>
            {translate('auto.components.right.sidebar.OutlinePanel.6987d54751', 'Retry')}
          </Button>
        )
      }
    }
    if (state.status === 'no-file') {
      return {
        icon: ListTree,
        title: translate(
          'auto.components.right.sidebar.OutlinePanel.e8bcf14f01',
          'Open a file to see its symbols'
        )
      }
    }
    if (state.status === 'unsupported') {
      return {
        icon: CircleOff,
        title: translate(
          'auto.components.right.sidebar.OutlinePanel.dee11bd70f',
          'No symbols for this file type'
        ),
        subtitle: translate(
          'auto.components.right.sidebar.OutlinePanel.2b8019ac88',
          'Supports C++ family files'
        )
      }
    }
    return null
  }, [state, retry])

  const filterLabel = translate(
    'auto.components.right.sidebar.OutlinePanel.308cd32c19',
    'Filter symbols'
  )
  const sortGlyphs: readonly {
    mode: OutlineSortMode
    label: string
    glyph: React.ReactNode
  }[] = [
    {
      mode: 'position',
      label: translate('auto.components.right.sidebar.OutlinePanel.9b6b841787', 'Sort by position'),
      glyph: <ArrowDownUp className="size-3" aria-hidden />
    },
    {
      mode: 'name',
      label: translate('auto.components.right.sidebar.OutlinePanel.20330722dc', 'Sort by name'),
      glyph: (
        <span className="font-mono text-[11px] leading-none" aria-hidden>
          A–Z
        </span>
      )
    },
    {
      mode: 'kind',
      label: translate('auto.components.right.sidebar.OutlinePanel.d8fa5b0f7d', 'Sort by kind'),
      glyph: <LayoutGrid className="size-3" aria-hidden />
    }
  ]

  const tree =
    visibleRows.length > 0 ? (
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek py-1">
        <OutlineTree
          rows={visibleRows}
          onReveal={reveal}
          query={filterQuery}
          collapsedKeys={collapsedKeys}
          onToggleCollapsed={toggleCollapsed}
          cursorRowKey={cursorRowKey}
        />
      </div>
    ) : indexing?.active ? (
      // #163: an empty result during indexing is expected, not a dead file.
      <OutlineEmptyState
        icon={Loader2}
        title={translate(
          'auto.components.right.sidebar.OutlinePanel.0fd325c2eb',
          'clangd is indexing this workspace'
        )}
        subtitle={
          indexing.percentage !== undefined
            ? translate('auto.components.right.sidebar.OutlinePanel.bef2a00066', '{{value0}}%', {
                value0: String(Math.round(indexing.percentage))
              })
            : translate(
                'auto.components.right.sidebar.OutlinePanel.3891f471e8',
                'Symbols appear as the index completes'
              )
        }
      />
    ) : (
      <OutlineEmptyState
        icon={ListTree}
        title={
          filtering
            ? translate(
                'auto.components.right.sidebar.OutlinePanel.093263f7bf',
                'No matching symbols'
              )
            : translate(
                'auto.components.right.sidebar.OutlinePanel.5c0a0b5e02',
                'No symbols in this file'
              )
        }
      />
    )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar"
      data-testid="outline-panel"
    >
      <div className="flex h-9 min-h-9 items-center gap-2 border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          {translate('auto.components.right.sidebar.OutlinePanel.7e498c4509', 'Outline')}
        </span>
        {approximate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                data-testid="outline-approximate-badge"
                aria-label={translate(
                  'auto.components.right.sidebar.OutlinePanel.70a1c94357',
                  'No language server connected — symbols are approximate and jumps are line-level'
                )}
              >
                {translate('auto.components.right.sidebar.OutlinePanel.9152d1a19e', 'Approximate')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-56">
              {translate(
                'auto.components.right.sidebar.OutlinePanel.70a1c94357',
                'No language server connected — symbols are approximate and jumps are line-level'
              )}
            </TooltipContent>
          </Tooltip>
        )}
        {fileName ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {fileName}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {rows.length > 0 && (
            <div className="flex overflow-hidden rounded-md border border-border">
              {sortGlyphs.map(({ mode, label, glyph }, index) => (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={sortMode === mode}
                      aria-label={label}
                      className={cn(
                        HEADER_CONTROL_CLASS,
                        'w-[30px]',
                        index > 0 && 'border-l border-border',
                        sortMode === mode && 'bg-accent text-foreground'
                      )}
                      onClick={() => setSortMode(mode)}
                    >
                      {glyph}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={filterOpen}
                aria-label={filterLabel}
                className={cn(
                  HEADER_CONTROL_CLASS,
                  'rounded-md',
                  filterOpen && 'bg-accent text-foreground'
                )}
                onClick={() => {
                  setFilterOpen((open) => !open)
                  // Closing the filter clears it — filtered rows must never stay hidden.
                  if (filterOpen) {
                    setFilterQuery('')
                  }
                }}
              >
                <ListFilter className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>{filterLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {filterOpen && (
        <div className="border-b border-border px-2 py-1.5">
          <Input
            type="text"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={filterLabel}
            aria-label={filterLabel}
            className="h-6"
          />
        </div>
      )}
      {state.status === 'loading' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-5 py-8 text-center">
          <Loader2 className="size-7 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-xs text-foreground">
            {translate('auto.components.right.sidebar.OutlinePanel.705b215356', 'Reading symbols…')}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.OutlinePanel.1495dd1774',
              'The first start can take a few seconds'
            )}
          </p>
        </div>
      )}
      {state.status !== 'loading' &&
        (statusBlock ? (
          // While filtering, the no-match state is the status; the tier footer
          // would stack a second status visual on top of it.
          rows.length > 0 || filtering ? (
            tree
          ) : (
            <OutlineEmptyState {...statusBlock} />
          )
        ) : (
          tree
        ))}
      {statusBlock && rows.length > 0 && !filtering && <OutlineStatusFooter block={statusBlock} />}
    </div>
  )
}

export default OutlinePanel
