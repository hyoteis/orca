import type React from 'react'
import { translate } from '@/i18n/i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { VIEW_SWITCH_ITEM_CLASS } from './FileExplorerViewSwitch'
import type { FileSearchRange } from '../../../../shared/types'

export type FileExplorerRangeSwitchProps = {
  range: FileSearchRange
  scopeRangeUnavailable: boolean
  onSelectRange: (range: FileSearchRange) => void
}

/** Find-strip range switch (#77): ◆ Scope searches Code scope member dirs only. */
export function FileExplorerRangeSwitch({
  range,
  scopeRangeUnavailable,
  onSelectRange
}: FileExplorerRangeSwitchProps): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={range}
      onValueChange={(value) => {
        if (value === 'worktree' || value === 'scope') {
          onSelectRange(value)
        }
      }}
      aria-label={translate(
        'auto.components.right.sidebar.FileExplorerRangeSwitch.43b9416a9a',
        'Explorer search range'
      )}
      className="flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-input/40 p-0.5"
      data-ignore-file-explorer-keys="true"
    >
      <ToggleGroupItem
        value="scope"
        disabled={scopeRangeUnavailable}
        title={
          scopeRangeUnavailable
            ? translate(
                'auto.components.right.sidebar.FileExplorerRangeSwitch.67c5cb400e',
                'No Code scope members to search yet'
              )
            : undefined
        }
        className={`${VIEW_SWITCH_ITEM_CLASS} w-auto min-w-0 px-2`}
      >
        {translate('auto.components.right.sidebar.FileExplorerRangeSwitch.31bc25f7ec', '◆ Scope')}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="worktree"
        className={`${VIEW_SWITCH_ITEM_CLASS} w-auto min-w-0 px-2`}
      >
        {translate('auto.components.right.sidebar.FileExplorerRangeSwitch.c893ba3003', 'Worktree')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
