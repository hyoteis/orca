import React from 'react'
import { Folder, FolderPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Configure Code dialog's member-folder rows (#141): the code folders the
 * workspace mode applies to. Pure presentational — picking/validation live in
 * the dialog. */
export function ConfigureCodeFolders({
  folders,
  onChange,
  onAddFolder,
  sshPicker
}: {
  folders: string[]
  onChange: (next: string[]) => void
  onAddFolder: () => void
  /** Inline SSH directory picker slot, rendered under the rows when active. */
  sshPicker?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-border px-3 py-2" data-configure-folders>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {translate('settings.codeIntelligence.foldersLabel', 'Code folders')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={onAddFolder}
        >
          <FolderPlus className="size-3" aria-hidden />
          {translate('settings.codeIntelligence.addFolder', 'Add folder…')}
        </Button>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {folders.map((folder) => (
          <li
            key={folder}
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-accent/50"
            data-configure-folder-row={folder}
          >
            <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {folder === '.'
                ? translate('settings.codeIntelligence.wholeWorkspace', '(whole workspace)')
                : folder}
            </span>
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={translate('settings.codeIntelligence.removeFolder', 'Remove folder')}
              onClick={() => onChange(folders.filter((path) => path !== folder))}
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
        {folders.length === 0 ? (
          <li className="px-1 py-0.5 text-[11px] text-muted-foreground">
            {translate(
              'settings.codeIntelligence.noFolders',
              'No code folders — add one to enable indexing'
            )}
          </li>
        ) : null}
      </ul>
      {sshPicker}
    </div>
  )
}
