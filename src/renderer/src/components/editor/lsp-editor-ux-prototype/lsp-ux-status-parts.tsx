/* PROTOTYPE (throwaway) — shared LSP UX status atoms for the editor prototype.
   Wayfinder ticket #179. Branch: prototype/lsp-editor-ux. */
import React from 'react'
import {
  Braces,
  Box,
  CircleDot,
  CircleX,
  FileCode2,
  Hammer,
  Hash,
  Info,
  KeySquare,
  Lightbulb,
  Link2,
  ListTree,
  Loader2,
  Lock,
  Monitor,
  Package,
  Puzzle,
  Server,
  Sigma,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CLANGD_VERSION,
  type FakeCompletion,
  type LspUxServerState
} from './lsp-ux-fake-data'

export const LSPUX_KIND_ICONS: Record<
  FakeCompletion['kindName'],
  React.ComponentType<{ className?: string }>
> = {
  Method: CircleDot,
  Field: Braces,
  Function: Sigma,
  Class: Box,
  Struct: ListTree,
  Enum: Hash,
  EnumMember: Link2,
  Variable: Wrench,
  Constant: Lock,
  Keyword: KeySquare,
  Snippet: Puzzle,
  Interface: Package
}

const PHASE_LABELS: Record<LspUxServerState['phase'], string> = {
  starting: 'starting',
  indexing: 'indexing',
  ready: 'ready',
  'crashed-restarting': 'restarting',
  'syntax-only': 'syntax-only'
}

const PHASE_DOT_CLASS: Record<LspUxServerState['phase'], string> = {
  starting: 'bg-muted-foreground',
  indexing: 'bg-[var(--workspace-status-progress)]',
  ready: 'bg-[var(--status-success)]',
  'crashed-restarting': 'bg-destructive',
  'syntax-only': 'bg-amber-500'
}

/** Status chip: dot + "clangd 19.1.2 · ready · host". The host fact is never hidden (SSH ownership must stay visible). */
export function ServerStatusChip({ state, compact }: { state: LspUxServerState; compact?: boolean }) {
  const spinning = state.phase === 'starting' || state.phase === 'crashed-restarting'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        state.phase === 'crashed-restarting' && 'text-destructive'
      )}
      data-testid="lspux-server-chip"
    >
      {spinning ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <span className={cn('size-1.5 shrink-0 rounded-full', PHASE_DOT_CLASS[state.phase])} />
      )}
      <span className="font-medium">
        {state.phase === 'crashed-restarting'
          ? 'clangd exited (code 1) — restarting 2/3'
          : state.phase === 'syntax-only'
            ? 'clangd syntax-only'
            : `clangd ${PHASE_LABELS[state.phase]}`}
      </span>
      {!compact && (
        <span className="text-muted-foreground">
          · {CLANGD_VERSION}
        </span>
      )}
      <HostBadge host={state.host} />
    </span>
  )
}

/** Execution-host badge: the SSH fact is load-bearing (clangd runs on the execution host). */
export function HostBadge({ host }: { host: LspUxServerState['host'] }) {
  const Icon = host.kind === 'ssh' ? Server : Monitor
  return (
    <span
      className={cn(
        'ml-1 inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] leading-4',
        host.kind === 'ssh'
          ? 'border-border bg-muted text-foreground'
          : 'border-transparent text-muted-foreground'
      )}
      data-testid="lspux-host-badge"
    >
      <Icon className="size-2.5" />
      {host.label}
    </span>
  )
}

/** $/progress surface: stage label + percentage + TU counter for the ~10 min first index. */
export function IndexingProgress({ state, inline }: { state: LspUxServerState; inline?: boolean }) {
  if (state.phase !== 'indexing' || !state.progress) {
    return null
  }
  const { percentage, message } = state.progress
  return (
    <div
      className={cn('flex items-center gap-2', inline ? 'min-w-[180px]' : 'w-full')}
      data-testid="lspux-indexing"
    >
      <Progress value={percentage ?? 0} className="h-1 w-24" />
      <span className="whitespace-nowrap text-muted-foreground">
        Indexing {percentage === null ? '' : `${percentage}% · `}
        <span className="font-mono">{message}</span>
      </span>
    </div>
  )
}

export type SeverityKey = 'error' | 'warning' | 'info' | 'hint'

export const SEVERITY_ICONS: Record<SeverityKey, React.ComponentType<{ className?: string }>> = {
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
  hint: Lightbulb
}

export const SEVERITY_TEXT_CLASS: Record<SeverityKey, string> = {
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-[var(--terminal-pane-locate)]',
  hint: 'text-muted-foreground'
}

export type DiagnosticRow = {
  severity: SeverityKey
  message: string
  source: string
  line: number
  column: number
}

/** Inline problem counts; clicking a count reveals the first diagnostic of that severity. */
export function ProblemCounts({
  rows,
  onPick
}: {
  rows: DiagnosticRow[]
  onPick: (row: DiagnosticRow) => void
}) {
  const counts: [SeverityKey, number][] = [
    ['error', rows.filter((r) => r.severity === 'error').length],
    ['warning', rows.filter((r) => r.severity === 'warning').length],
    ['info', rows.filter((r) => r.severity === 'info').length],
    ['hint', rows.filter((r) => r.severity === 'hint').length]
  ]
  return (
    <span className="inline-flex items-center gap-2.5" data-testid="lspux-problem-counts">
      {counts.map(([severity, count]) => {
        const Icon = SEVERITY_ICONS[severity]
        return (
          <button
            key={severity}
            onClick={() => {
              const first = rows.find((r) => r.severity === severity)
              if (first) {
                onPick(first)
              }
            }}
            className={cn(
              'inline-flex items-center gap-1 transition-opacity hover:opacity-80',
              count === 0 && 'pointer-events-none opacity-40',
              SEVERITY_TEXT_CLASS[severity]
            )}
            aria-label={`${count} ${severity}s`}
          >
            <Icon className="size-3" />
            <span className="tabular-nums">{count}</span>
          </button>
        )
      })}
    </span>
  )
}

/** Degradation notice: syntax-level mode is a product-level fact, never silently faked as semantic. */
export function DegradationBanner({
  host,
  onDismiss
}: {
  host: LspUxServerState['host']
  onDismiss?: () => void
}) {
  return (
    <div
      role="status"
      className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs"
      data-testid="lspux-degradation-banner"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 font-medium text-foreground">
            Syntax-level mode — no <span className="font-mono">compile_commands.json</span> found
            {host.kind === 'ssh' ? ` on ${host.label}` : ''}. Cross-file navigation, hover, and
            diagnostics are unavailable until one is generated.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" variant="outline">
            <Hammer className="mr-1 size-3" />
            Generate
          </Button>
          {onDismiss ? (
            <Button type="button" size="xs" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Diagnostics list for the panel/dropdown surfaces. */
export function DiagnosticsList({
  rows,
  onPick
}: {
  rows: DiagnosticRow[]
  onPick: (row: DiagnosticRow) => void
}) {
  if (rows.length === 0) {
    return (
      <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        No diagnostics for this file
      </p>
    )
  }
  return (
    <ul className="flex flex-col" data-testid="lspux-diagnostics-list">
      {rows.map((row) => {
        const Icon = SEVERITY_ICONS[row.severity]
        return (
          <li key={`${row.severity}:${row.line}:${row.column}`}>
            <button
              type="button"
              onClick={() => onPick(row)}
              className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <Icon className={cn('mt-0.5 size-3 shrink-0', SEVERITY_TEXT_CLASS[row.severity])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{row.message}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                  {row.source} · :{row.line}:{row.column}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Counts trigger that opens the full list in a popover (variant B). */
export function ProblemCountsPopover({
  rows,
  onPick
}: {
  rows: DiagnosticRow[]
  onPick: (row: DiagnosticRow) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded px-1 py-0.5 transition-colors hover:bg-accent"
          data-testid="lspux-problem-trigger"
        >
          <ProblemCounts rows={rows} onPick={onPick} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-1">
        <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Problems — RefTracker.cpp
        </p>
        <DiagnosticsList rows={rows} onPick={onPick} />
      </PopoverContent>
    </Popover>
  )
}

/** Legend: how CompletionItemKinds map onto repo (lucide) icons. */
export function CompletionKindLegend({ className }: { className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-x-3 gap-y-1.5 px-2 py-2', className)}>
      {Object.entries(LSPUX_KIND_ICONS).map(([kindName, Icon]) => {
        return (
          <span key={kindName} className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Icon className="size-3 text-muted-foreground" />
            {kindName}
          </span>
        )
      })}
    </div>
  )
}

/** Server card for the panel variant. */
export function ServerPanelCard({ state }: { state: LspUxServerState }) {
  return (
    <div className="border-b px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <ServerStatusChip state={state} />
        <Badge variant="secondary" className="text-[10px] font-normal">
          LSP
        </Badge>
      </div>
      <div className="mt-2.5">
        <IndexingProgress state={state} />
        {state.phase === 'ready' ? (
          <p className="text-[11px] text-muted-foreground">
            Background index ready · 98,417 TUs · 1.8 GB
          </p>
        ) : null}
        {state.phase === 'starting' ? (
          <p className="text-[11px] text-muted-foreground">Spawning on {state.host.label}…</p>
        ) : null}
      </div>
    </div>
  )
}

/** Fake open-file tab strip shared by all variants. */
export function FakeTabStrip({ degraded }: { degraded?: boolean }) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b bg-background">
      <div
        className={cn(
          'flex items-center gap-2 border-r-2 border-primary px-3 text-[13px]',
          degraded ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        <FileCode2 className="size-3.5 text-muted-foreground" />
        RefTracker.cpp
        <span className="size-1.5 rounded-full bg-foreground/40" aria-label="unsaved changes" />
      </div>
      <div className="flex items-center gap-2 px-3 text-[13px] text-muted-foreground/70">
        CMakeLists.txt
      </div>
      <div className="flex items-center gap-2 px-3 text-[13px] text-muted-foreground/70">
        README.md
      </div>
    </div>
  )
}
