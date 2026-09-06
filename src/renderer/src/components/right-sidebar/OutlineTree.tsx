import React from 'react'
import {
  Braces,
  Box,
  ChevronRight,
  CircleDot,
  Globe,
  Package,
  SquareFunction,
  Type,
  Variable,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OutlineSymbolRow } from './outline-model'
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

/** Name with `<mark>` runs on filter matches, per the approved prototype. */
function OutlineName({ name, query }: { name: string; query: string }): React.JSX.Element {
  const needle = query.trim().toLowerCase()
  const segments: { text: string; match: boolean }[] = []
  if (!needle) {
    segments.push({ text: name, match: false })
  } else {
    const lower = name.toLowerCase()
    let offset = 0
    for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, offset)) {
      if (index > offset) {
        segments.push({ text: name.slice(offset, index), match: false })
      }
      segments.push({ text: name.slice(index, index + needle.length), match: true })
      offset = index + needle.length
    }
    if (offset < name.length) {
      segments.push({ text: name.slice(offset), match: false })
    }
  }
  return (
    <span className="min-w-0 truncate font-mono text-xs text-foreground">
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={index}
            className="rounded-[2px] bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)] px-px text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </span>
  )
}

/** Nesting per prototype: 14px/level, 1px hairline, 24px rows. An active row
 * uses the jump-palette selection recipe (foreground mix + inset bar). */
export function OutlineTree({
  rows,
  onReveal,
  query,
  collapsedKeys,
  onToggleCollapsed,
  cursorRowKey
}: {
  rows: readonly OutlineSymbolRow[]
  onReveal: (row: OutlineSymbolRow) => void
  query: string
  collapsedKeys: ReadonlySet<string>
  onToggleCollapsed: (key: string) => void
  cursorRowKey: string | null
}): React.JSX.Element {
  const filtering = query.trim().length > 0
  return (
    <ul className="min-w-0">
      {rows.map((row) => {
        // Filter forces expansion so matches under collapsed ancestors show.
        const expanded = filtering || !collapsedKeys.has(row.key)
        const isActive = cursorRowKey === row.key
        return (
          <li key={row.key}>
            <div
              data-active={isActive || undefined}
              className={cn(
                'group flex h-6 items-center pr-2',
                isActive
                  ? 'bg-[color-mix(in_srgb,var(--foreground)_12%,var(--sidebar))] shadow-[inset_2px_0_0_var(--foreground)]'
                  : 'hover:bg-accent'
              )}
            >
              {row.children.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={translate(
                    expanded
                      ? 'auto.components.right.sidebar.OutlineTree.313394b2bc'
                      : 'auto.components.right.sidebar.OutlineTree.6bd66ac455',
                    expanded ? 'Collapse' : 'Expand'
                  )}
                  className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onToggleCollapsed(row.key)}
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                    aria-hidden
                  />
                </button>
              ) : (
                <span className="size-5 shrink-0" aria-hidden />
              )}
              <button
                type="button"
                data-outline-row={row.name}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => onReveal(row)}
              >
                <KindIcon kind={row.kind} />
                <OutlineName name={row.name} query={query} />
                <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
                  {row.line}
                </span>
              </button>
            </div>
            {row.children.length > 0 && expanded && (
              <div className="ml-3.5 border-l border-border">
                <OutlineTree
                  rows={row.children}
                  onReveal={onReveal}
                  query={query}
                  collapsedKeys={collapsedKeys}
                  onToggleCollapsed={onToggleCollapsed}
                  cursorRowKey={cursorRowKey}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
