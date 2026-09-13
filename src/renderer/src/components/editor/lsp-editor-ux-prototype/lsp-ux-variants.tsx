// PROTOTYPE (throwaway) — the three structural variants of the LSP editor UX.
// Wayfinder ticket #179. Branch: prototype/lsp-editor-ux.
//
// Variant A: VS Code-style bottom status strip; degradation = dismissible top banner.
// Variant B: everything in the editor header strip; degradation = persistent banner.
// Variant C: dedicated right language panel; degradation = pinned notice in the panel.
import React from 'react'
import { TriangleAlert } from 'lucide-react'
import {
  CompletionKindLegend,
  DegradationBanner,
  DiagnosticsList,
  FakeTabStrip,
  IndexingProgress,
  ProblemCounts,
  ProblemCountsPopover,
  ServerPanelCard,
  ServerStatusChip,
  type DiagnosticRow
} from './lsp-ux-status-parts'
import { LspUxMonacoSurface, diagnosticsRowsForPhase } from './lsp-ux-monaco-surface'
import type { LspUxServerState } from './lsp-ux-fake-data'

export type VariantProps = {
  serverState: LspUxServerState
  revealLine: number | null
  onPickDiagnostic: (row: DiagnosticRow) => void
  onRevealDone: () => void
}

export function VariantA({
  serverState,
  revealLine,
  onPickDiagnostic,
  onRevealDone
}: VariantProps): React.JSX.Element {
  const rows = diagnosticsRowsForPhase(serverState.phase)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="lspux-variant-a">
      <FakeTabStrip degraded={serverState.phase === 'syntax-only'} />
      {serverState.phase === 'syntax-only' ? <DegradationBanner host={serverState.host} /> : null}
      <LspUxMonacoSurface
        serverState={serverState}
        revealLine={revealLine}
        onRevealDone={onRevealDone}
      />
      <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-2 text-[11px] text-muted-foreground">
        <ServerStatusChip state={serverState} compact />
        <IndexingProgress state={serverState} />
        <span className="flex-1" />
        <ProblemCounts rows={rows} onPick={onPickDiagnostic} />
      </div>
    </div>
  )
}

export function VariantB({
  serverState,
  revealLine,
  onPickDiagnostic,
  onRevealDone
}: VariantProps): React.JSX.Element {
  const rows = diagnosticsRowsForPhase(serverState.phase)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="lspux-variant-b">
      <FakeTabStrip degraded={serverState.phase === 'syntax-only'} />
      <div className="editor-header flex-wrap">
        <ServerStatusChip state={serverState} />
        <IndexingProgress state={serverState} inline />
        <span className="flex-1" />
        <ProblemCountsPopover rows={rows} onPick={onPickDiagnostic} />
      </div>
      {serverState.phase === 'syntax-only' ? <DegradationBanner host={serverState.host} /> : null}
      <LspUxMonacoSurface
        serverState={serverState}
        revealLine={revealLine}
        onRevealDone={onRevealDone}
      />
    </div>
  )
}

export function VariantC({
  serverState,
  revealLine,
  onPickDiagnostic,
  onRevealDone
}: VariantProps): React.JSX.Element {
  const rows = diagnosticsRowsForPhase(serverState.phase)
  return (
    <div className="flex h-full min-h-0" data-testid="lspux-variant-c">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <FakeTabStrip degraded={serverState.phase === 'syntax-only'} />
        <LspUxMonacoSurface
          serverState={serverState}
          revealLine={revealLine}
          onRevealDone={onRevealDone}
        />
        <div className="pointer-events-none absolute right-2 top-11 rounded-full border bg-background/90 px-2 py-0.5 text-[11px] shadow-xs backdrop-blur-sm">
          <span className="pointer-events-auto">
            <ServerStatusChip state={serverState} compact />
          </span>
        </div>
      </div>
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l bg-card scrollbar-sleek">
        <ServerPanelCard state={serverState} />
        {serverState.phase === 'syntax-only' ? (
          <div
            className="border-b bg-amber-500/10 px-3 py-2 text-[11px] text-foreground"
            data-testid="lspux-degradation-panel-notice"
          >
            <span className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
              Syntax-level mode · no{' '}
              <span className="font-mono">compile_commands.json</span>
            </span>
            <span className="mt-1 block text-muted-foreground">
              Hover, navigation, and cross-file checks are off.
            </span>
          </div>
        ) : null}
        <section className="border-b">
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Problems — RefTracker.cpp
          </p>
          <DiagnosticsList rows={rows} onPick={onPickDiagnostic} />
        </section>
        <section>
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Completion kinds
          </p>
          <CompletionKindLegend />
          <p className="px-3 pb-3 text-[11px] leading-relaxed text-muted-foreground">
            Suggest-widget icons come from the repo’s lucide set; snippets use the primary token.
            Type <span className="font-mono">Edges.</span> or{' '}
            <span className="font-mono">llvm::</span> in the editor to see the widget.
          </p>
        </section>
      </aside>
    </div>
  )
}
