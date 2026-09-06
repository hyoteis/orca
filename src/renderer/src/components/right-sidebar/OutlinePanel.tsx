import React from 'react'
import {
  Braces,
  Box,
  CircleDot,
  CircleOff,
  Globe,
  ListTree,
  Loader2,
  Package,
  SquareFunction,
  Type,
  Variable,
  type LucideIcon
} from 'lucide-react'
import type { OutlineSymbolRow } from './outline-model'
import { useOutlineSymbols } from './use-outline-symbols'
import { translate } from '@/i18n/i18n'

// LSP SymbolKind 1..26 → monochrome kind icons; unmapped kinds fall back.
const KIND_ICONS: Record<number, LucideIcon> = {
  2: Box, // Module
  3: Globe, // Namespace
  4: Package, // Package
  5: Braces, // Class
  6: SquareFunction, // Method
  7: CircleDot, // Property
  8: CircleDot, // Field
  9: SquareFunction, // Constructor
  10: Type, // Enum
  11: Type, // Interface
  12: SquareFunction, // Function
  13: Variable, // Variable
  14: Variable, // Constant
  22: CircleDot, // EnumMember
  23: Braces, // Struct
  26: Type // TypeParameter
}

function KindIcon({ kind }: { kind: number }): React.JSX.Element {
  const Icon = KIND_ICONS[kind] ?? Braces
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
}

/** Default-expanded nesting per prototype: 14px/level, 1px hairline. */
function OutlineRows({
  rows,
  onReveal
}: {
  rows: readonly OutlineSymbolRow[]
  onReveal: (row: OutlineSymbolRow) => void
}): React.JSX.Element {
  return (
    <ul className="min-w-0">
      {rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            className="group flex h-6 w-full min-w-0 items-center gap-1.5 px-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onReveal(row)}
          >
            <KindIcon kind={row.kind} />
            <span className="min-w-0 truncate font-mono text-xs text-foreground">{row.name}</span>
            <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
              {row.line}
            </span>
          </button>
          {row.children.length > 0 && (
            <div className="ml-[13px] border-l border-border">
              <OutlineRows rows={row.children} onReveal={onReveal} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function OutlineEmptyState({
  icon: Icon,
  title,
  subtitle
}: {
  icon: LucideIcon
  title: string
  subtitle?: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-5 py-8 text-center">
      <Icon className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-xs text-foreground">{title}</p>
      {subtitle ? <p className="text-[11px] text-muted-foreground">{subtitle}</p> : null}
    </div>
  )
}

/** Right-sidebar Outline tab (#99): symbol tree of the active editor file. */
export function OutlinePanel(): React.JSX.Element {
  const { state, fileName, reveal } = useOutlineSymbols()
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar"
      data-testid="outline-panel"
    >
      <div className="flex h-9 min-h-9 items-center gap-2 border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          {translate('auto.components.right.sidebar.OutlinePanel.7e498c4509', 'Outline')}
        </span>
        {fileName ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {fileName}
          </span>
        ) : null}
      </div>
      {state.status === 'loading' && (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span>
            {translate('auto.components.right.sidebar.OutlinePanel.705b215356', 'Reading symbols…')}
          </span>
        </div>
      )}
      {state.status === 'no-file' && (
        <OutlineEmptyState
          icon={ListTree}
          title={translate(
            'auto.components.right.sidebar.OutlinePanel.e8bcf14f01',
            'Open a file to see its symbols'
          )}
        />
      )}
      {state.status === 'unsupported' && (
        <OutlineEmptyState
          icon={CircleOff}
          title={translate(
            'auto.components.right.sidebar.OutlinePanel.dee11bd70f',
            'No symbols for this file type'
          )}
          subtitle={translate(
            'auto.components.right.sidebar.OutlinePanel.edd26ca39f',
            'Supports Python files'
          )}
        />
      )}
      {state.status === 'unavailable' && state.reason === 'no-scope' && (
        <OutlineEmptyState
          icon={Braces}
          title={translate(
            'auto.components.right.sidebar.OutlinePanel.a54eff7728',
            'No symbols available'
          )}
          subtitle={translate(
            'auto.components.right.sidebar.OutlinePanel.a7fc6e9b08',
            'No code-intelligence scope covers this file'
          )}
        />
      )}
      {state.status === 'unavailable' && state.reason === 'consent' && (
        <OutlineEmptyState
          icon={Braces}
          title={translate(
            'auto.components.right.sidebar.OutlinePanel.a54eff7728',
            'No symbols available'
          )}
          subtitle={translate(
            'auto.components.right.sidebar.OutlinePanel.51971afea7',
            'Code intelligence needs authorization for this workspace'
          )}
        />
      )}
      {state.status === 'ready' &&
        (state.rows.length === 0 ? (
          <OutlineEmptyState
            icon={ListTree}
            title={translate(
              'auto.components.right.sidebar.OutlinePanel.5c0a0b5e02',
              'No symbols in this file'
            )}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek py-1">
            <OutlineRows rows={state.rows} onReveal={reveal} />
          </div>
        ))}
    </div>
  )
}

export default OutlinePanel
