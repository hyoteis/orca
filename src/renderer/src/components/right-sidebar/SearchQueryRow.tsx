import React from 'react'
import { Search as SearchIcon, Braces, CaseSensitive, WholeWord, Regex, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleButton } from './SearchResultItems'
import { translate } from '@/i18n/i18n'

export type SearchQueryRowProps = {
  inputRef: React.Ref<HTMLInputElement>
  query: string
  loading: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  /** #32 Symbols mode: workspace-symbol Command center over the same query box. */
  symbolMode: boolean
  onQueryChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onClearSearch: () => void
  onToggleCaseSensitive: () => void
  onToggleWholeWord: () => void
  onToggleRegex: () => void
  onToggleSymbolMode: () => void
}

export function SearchQueryRow({
  inputRef,
  query,
  loading,
  caseSensitive,
  wholeWord,
  useRegex,
  symbolMode,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onToggleSymbolMode
}: SearchQueryRowProps): React.JSX.Element {
  return (
    <div
      className="flex h-7 items-center gap-1 rounded-sm border border-border bg-input/50 px-1.5 focus-within:border-ring"
      data-ignore-file-explorer-keys="true"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        className="min-w-0 flex-1 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
        aria-label={translate(
          symbolMode
            ? 'auto.components.right.sidebar.SearchQueryRow.symbolPlaceholder'
            : 'auto.components.right.sidebar.SearchQueryRow.queryLabel',
          symbolMode ? 'Search symbols' : 'Search files'
        )}
        placeholder={translate(
          symbolMode
            ? 'auto.components.right.sidebar.SearchQueryRow.symbolPlaceholder'
            : 'auto.components.right.sidebar.SearchHeader.693cbeadd0',
          symbolMode ? 'Search symbols' : 'Search'
        )}
        value={query}
        onChange={onQueryChange}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      {loading ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-auto w-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.SearchQueryRow.clearLabel',
            'Clear search'
          )}
          onClick={onClearSearch}
        >
          <X className="size-3" />
        </Button>
      ) : null}
      <ToggleButton
        active={symbolMode}
        onClick={onToggleSymbolMode}
        title={translate(
          'auto.components.right.sidebar.SearchQueryRow.symbolMode',
          'Toggle workspace symbol search'
        )}
      >
        <Braces className="size-3.5" />
      </ToggleButton>
      {!symbolMode ? (
        <>
          <ToggleButton
            active={caseSensitive}
            onClick={onToggleCaseSensitive}
            title={translate('auto.components.right.sidebar.SearchHeader.464ae3974f', 'Match Case')}
          >
            <CaseSensitive className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={wholeWord}
            onClick={onToggleWholeWord}
            title={translate(
              'auto.components.right.sidebar.SearchHeader.4567e6e0b6',
              'Match Whole Word'
            )}
          >
            <WholeWord className="size-3.5" />
          </ToggleButton>
          <ToggleButton
            active={useRegex}
            onClick={onToggleRegex}
            title={translate(
              'auto.components.right.sidebar.SearchHeader.6234a5ef85',
              'Use Regular Expression'
            )}
          >
            <Regex className="size-3.5" />
          </ToggleButton>
        </>
      ) : null}
    </div>
  )
}
