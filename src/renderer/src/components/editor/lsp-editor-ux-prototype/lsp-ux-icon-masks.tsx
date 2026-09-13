// PROTOTYPE (throwaway) — replaces Monaco's codicon completion-kind glyphs with the
// repo's lucide icons inside the suggest widget (mask + token color, so light/dark both work).
// Wayfinder ticket #179. Branch: prototype/lsp-editor-ux.
import React, { useEffect, useRef } from 'react'
import { LSPUX_KIND_ICONS } from './lsp-ux-status-parts'
import type { FakeCompletion } from './lsp-ux-fake-data'

/** kindName → the codicon class Monaco's suggest renderer derives from CompletionItemKind. */
const CODICON_CLASS_BY_KIND: Record<FakeCompletion['kindName'], string> = {
  Method: 'codicon-symbol-method',
  Function: 'codicon-symbol-function',
  Field: 'codicon-symbol-field',
  Variable: 'codicon-symbol-variable',
  Class: 'codicon-symbol-class',
  Struct: 'codicon-symbol-struct',
  Interface: 'codicon-symbol-interface',
  Enum: 'codicon-symbol-enum',
  EnumMember: 'codicon-symbol-enum-member',
  Constant: 'codicon-symbol-constant',
  Keyword: 'codicon-symbol-key',
  Snippet: 'codicon-symbol-snippet'
}

const KIND_NAMES: FakeCompletion['kindName'][] = [
  'Method',
  'Field',
  'Function',
  'Class',
  'Struct',
  'Enum',
  'EnumMember',
  'Variable',
  'Constant',
  'Keyword',
  'Snippet',
  'Interface'
]

const STYLE_ELEMENT_ID = 'lspux-kind-icon-masks'

/**
 * Renders the lucide icons once offscreen, serializes their SVG, and injects
 * mask-image rules that override the codicon glyphs inside `.lspux-proto`.
 * Colors: monochrome muted (styleguide: color reserved for state); snippets use primary.
 */
export function LspUxKindIconMaskStyles(): React.JSX.Element | null {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const svgByKind = new Map<FakeCompletion['kindName'], string>()
    for (const kind of KIND_NAMES) {
      const svg = host.querySelector(`[data-kind-host="${kind}"] svg`)
      if (svg) {
        svgByKind.set(kind, svg.outerHTML)
      }
    }
    const rules = Array.from(svgByKind.entries())
      .map(([kind, svg]) => {
        const codicon = CODICON_CLASS_BY_KIND[kind]
        const uri = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`
        const color = kind === 'Snippet' ? 'var(--primary)' : 'var(--muted-foreground)'
        return [
          `.lspux-proto .suggest-icon.${codicon} {`,
          `  background-color: ${color};`,
          `  -webkit-mask-image: ${uri};`,
          `  mask-image: ${uri};`,
          '  -webkit-mask-size: 88%; mask-size: 88%;',
          '  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;',
          '  -webkit-mask-position: center; mask-position: center;',
          '}',
          `.lspux-proto .suggest-icon.${codicon}::before { content: none; }`
        ].join('\n')
      })
      .join('\n')
    const existing = document.getElementById(STYLE_ELEMENT_ID)
    const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    if (existing === null) {
      document.head.appendChild(style)
    }
    style.textContent = rules
    return () => {
      style?.remove()
    }
  }, [])

  return (
    <div ref={hostRef} aria-hidden="true" style={{ position: 'fixed', left: -9999, top: 0 }}>
      {KIND_NAMES.map((kind) => {
        const Icon = LSPUX_KIND_ICONS[kind]
        return (
          <span key={kind} data-kind-host={kind}>
            <Icon className="" />
          </span>
        )
      })}
    </div>
  )
}
