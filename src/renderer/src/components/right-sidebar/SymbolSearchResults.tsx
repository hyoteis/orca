import React from 'react'
import { Braces, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SymbolRow } from './symbol-search-rows'

type SymbolSearchResultsProps = {
  query: string
  rows: SymbolRow[]
  loading: boolean
  partial: boolean
  onOpen: (row: SymbolRow) => void
  /** #13 labelled fallback: rerun the same query as text search. */
  onFallbackToText: () => void
}

/** Symbols view of the Explorer search panel (#32 Command center). */
export function SymbolSearchResults({
  query,
  rows,
  loading,
  partial,
  onOpen,
  onFallbackToText
}: SymbolSearchResultsProps): React.JSX.Element {
  // ponytail: plain list — pyright/clangd answer in the hundreds; virtualize like
  // SearchResultsPane if symbol floods ever make scroll jank measurable.
  return (
    <>
      {/* Header also covers rows.length===0 so an all-scopes rejection reads as
          Partial, not as a plain no-match (#13). */}
      {(rows.length > 0 || partial) && (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.SymbolSearchResults.symbolCount',
            '{{value0}} symbols',
            { value0: rows.length }
          )}
          {loading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {partial ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-semibold uppercase text-muted-foreground">
              {translate('settings.codeIntelligence.partialResults', 'Partial')}
            </span>
          ) : null}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {rows.map((row) => (
          <Button
            key={row.key}
            type="button"
            variant="ghost"
            disabled={!row.range}
            className="h-auto w-full justify-start gap-2 rounded-none px-2 py-1 text-left"
            title={row.range ? row.displayPath : unresolvedSymbolTitle()}
            onClick={() => onOpen(row)}
          >
            <Braces className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground">
              {row.kindLabel}
            </span>
            <span className="min-w-0 shrink truncate font-mono text-xs text-foreground">
              {row.name}
            </span>
            {row.containerName ? (
              <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
                {row.containerName}
              </span>
            ) : null}
            {row.external ? (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] font-semibold uppercase text-muted-foreground">
                {translate('settings.codeIntelligence.externalDependency', 'External dependency')}
              </span>
            ) : null}
            <span className="ml-auto min-w-0 max-w-[40%] shrink-0 truncate text-right text-[11px] text-muted-foreground">
              {row.displayPath}
            </span>
          </Button>
        ))}
        {!query.trim() && (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.SymbolSearchResults.typeToSearch',
              'Type to search workspace symbols'
            )}
          </div>
        )}
        {query.trim() && !loading && rows.length === 0 && !partial && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>
              {translate(
                'auto.components.right.sidebar.SymbolSearchResults.noSymbols',
                'No matching symbols'
              )}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={onFallbackToText}>
              {translate(
                'auto.components.right.sidebar.SymbolSearchResults.searchTextInstead',
                'Search text instead'
              )}
            </Button>
          </div>
        )}
        {query.trim() && !loading && rows.length === 0 && partial && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>
              {translate(
                'auto.components.right.sidebar.SymbolSearchResults.partialEmpty',
                'Some scopes failed to answer'
              )}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={onFallbackToText}>
              {translate(
                'auto.components.right.sidebar.SymbolSearchResults.searchTextInstead',
                'Search text instead'
              )}
            </Button>
          </div>
        )}
        {query.trim() && loading && rows.length === 0 && (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            {translate(
              'auto.components.right.sidebar.SymbolSearchResults.searching',
              'Searching symbols…'
            )}
          </div>
        )}
      </div>
    </>
  )
}

function unresolvedSymbolTitle(): string {
  return translate(
    'auto.components.right.sidebar.SymbolSearchResults.unresolvedLocation',
    'Symbol location unresolved'
  )
}
