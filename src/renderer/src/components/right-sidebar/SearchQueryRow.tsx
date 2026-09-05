import React from 'react'
import { Search as SearchIcon, Braces, CaseSensitive, WholeWord, Regex, X, Loader2, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ToggleButton } from './SearchResultItems'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { FileSearchRange } from '../../../../shared/types'

export type SearchQueryRowProps = {
  inputRef: React.Ref<HTMLInputElement>
  query: string
  loading: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  /** #32 Symbols mode: workspace-symbol Command center over the same query box. */
  symbolMode: boolean
  /** #77 search range, collapsed into the field as a prefix pill (variant C). */
  range: FileSearchRange
  scopeRangeUnavailable: boolean
  onSelectRange: (range: FileSearchRange) => void
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
  range,
  scopeRangeUnavailable,
  onSelectRange,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onToggleSymbolMode
}: SearchQueryRowProps): React.JSX.Element {
  // Labels reuse the section-title keys so the pill always matches the
  // sections its range hosts results in (Files block / Workspace section).
  const rangeLabel =
    range === 'scope'
      ? translate('auto.components.right.sidebar.CodeScopesSection.title', 'Workspace')
      : translate('auto.components.right.sidebar.WorktreeSection.title', 'Files')
  return (
    <div
      className="flex h-7 items-center gap-1 rounded-sm border border-border bg-input/50 px-1.5 focus-within:border-ring"
      data-ignore-file-explorer-keys="true"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={translate(
              'auto.components.right.sidebar.FileExplorerRangeSwitch.43b9416a9a',
              'Explorer search range'
            )}
            aria-label={translate(
              'auto.components.right.sidebar.FileExplorerRangeSwitch.43b9416a9a',
              'Explorer search range'
            )}
            className="flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {rangeLabel}
            <ChevronDown className="size-2.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-28">
          <DropdownMenuItem
            disabled={scopeRangeUnavailable}
            title={
              scopeRangeUnavailable
                ? translate(
                    'auto.components.right.sidebar.FileExplorerRangeSwitch.67c5cb400e',
                    'No Code scope members to search yet'
                  )
                : undefined
            }
            onClick={() => onSelectRange('scope')}
          >
            <span className={cn('flex-1', range === 'scope' && 'font-medium')}>
              {translate('auto.components.right.sidebar.CodeScopesSection.title', 'Workspace')}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelectRange('worktree')}>
            <span className={cn('flex-1', range === 'worktree' && 'font-medium')}>
              {translate('auto.components.right.sidebar.WorktreeSection.title', 'Files')}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-px shrink-0 bg-border" aria-hidden />
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
