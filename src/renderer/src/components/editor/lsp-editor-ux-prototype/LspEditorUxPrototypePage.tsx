// PROTOTYPE (throwaway) — LSP editor UX prototype page (wayfinder ticket #179).
// Branch: prototype/lsp-editor-ux. Fake data only; no LSP server is contacted.
// Three variants, switched with ← / → or the floating bar; the fake server phase
// and execution host are steerable so every state is inspectable without waiting.
import React, { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  LOCAL_HOST,
  SSH_HOST,
  SERVER_STATES,
  type LspUxServerPhase,
  type LspUxServerState,
  type LspUxHost
} from './lsp-ux-fake-data'
import { LspUxKindIconMaskStyles } from './lsp-ux-icon-masks'
import { VariantA, VariantB, VariantC, type VariantProps } from './lsp-ux-variants'
import type { DiagnosticRow } from './lsp-ux-status-parts'

const VARIANTS = [
  { key: 'a', name: 'Bottom status strip', Component: VariantA },
  { key: 'b', name: 'Editor header strip', Component: VariantB },
  { key: 'c', name: 'Right language panel', Component: VariantC }
] as const

const PHASES: LspUxServerPhase[] = [
  'starting',
  'indexing',
  'ready',
  'crashed-restarting',
  'syntax-only'
]

function variantFromHash(): string {
  const match = /^#lspux-([abc])$/.exec(window.location.hash)
  return match ? match[1] : 'a'
}

export default function LspEditorUxPrototypePage(): React.JSX.Element {
  const [variantKey, setVariantKey] = useState(variantFromHash)
  const [phase, setPhase] = useState<LspUxServerPhase>('ready')
  const [host, setHost] = useState<LspUxHost>(SSH_HOST)
  const [revealLine, setRevealLine] = useState<number | null>(null)

  useEffect(() => {
    const onHashChange = () => setVariantKey(variantFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // ← / → cycle variants; never steal keys from inputs or the Monaco surface.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (
        target.closest('input, textarea, [contenteditable="true"], .monaco-editor, .lspux-switcher')
      ) {
        return
      }
      const index = VARIANTS.findIndex((v) => v.key === variantKey)
      const next =
        event.key === 'ArrowRight'
          ? VARIANTS[(index + 1) % VARIANTS.length]
          : VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length]
      window.location.hash = `lspux-${next.key}`
      setVariantKey(next.key)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [variantKey])

  const serverState: LspUxServerState = { phase, host, ...SERVER_STATES[phase] }

  const onPickDiagnostic = useCallback((row: DiagnosticRow) => {
    setRevealLine(row.line)
  }, [])
  const onRevealDone = useCallback(() => {
    setRevealLine(null)
  }, [])

  const variantProps: VariantProps = {
    serverState,
    revealLine,
    onPickDiagnostic,
    onRevealDone
  }
  const ActiveVariant =
    VARIANTS.find((v) => v.key === variantKey)?.Component ?? VariantA
  const activeName = VARIANTS.find((v) => v.key === variantKey)?.name ?? VARIANTS[0].name

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--editor-surface)]">
      <LspUxKindIconMaskStyles />
      {/* Keyed remount per variant so each layout gets a fresh Monaco surface. */}
      <ActiveVariant key={variantKey} {...variantProps} />

      <div className="lspux-switcher" data-testid="lspux-switcher">
        <div className="lspux-switcher-row">
          <button
            type="button"
            aria-label="Previous variant"
            onClick={() => {
              const index = VARIANTS.findIndex((v) => v.key === variantKey)
              const next = VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length]
              window.location.hash = `lspux-${next.key}`
              setVariantKey(next.key)
            }}
          >
            <ChevronLeft className="size-3" />
          </button>
          <span className="lspux-switcher-label">
            {variantKey.toUpperCase()} · {activeName}
          </span>
          <button
            type="button"
            aria-label="Next variant"
            onClick={() => {
              const index = VARIANTS.findIndex((v) => v.key === variantKey)
              const next = VARIANTS[(index + 1) % VARIANTS.length]
              window.location.hash = `lspux-${next.key}`
              setVariantKey(next.key)
            }}
          >
            <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="lspux-switcher-row">
          {PHASES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-active={phase === candidate}
              onClick={() => setPhase(candidate)}
            >
              {candidate}
            </button>
          ))}
          <span className="mx-1 opacity-40">|</span>
          <button type="button" data-active={host.kind === 'ssh'} onClick={() => setHost(SSH_HOST)}>
            ssh host
          </button>
          <button
            type="button"
            data-active={host.kind === 'local'}
            onClick={() => setHost(LOCAL_HOST)}
          >
            local
          </button>
        </div>
      </div>
    </div>
  )
}
