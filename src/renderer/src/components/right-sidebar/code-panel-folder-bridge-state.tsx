import React from 'react'
import { FolderInput, FolderX, Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** #72 variant A: provenance line shown when a folder workspace rides the linked project's scopes. */
export function FolderBridgeInfoLine({ repoName }: { repoName: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 px-2 py-1 text-[11px] leading-snug text-muted-foreground">
      <Link className="mt-0.5 size-3 shrink-0" />
      {translate(
        'auto.components.rightSidebar.CodePanel.bridgedInfo',
        'Code folders come from the linked project {{value0}}; changes here write back to it.',
        { value0: repoName }
      )}
    </div>
  )
}

/** Gap state of variant A: the folder has no linked project yet, so no scopes can exist. */
export function FolderNotProjectEmptyState({
  onAddAsProject
}: {
  onAddAsProject: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-7 text-center">
      <FolderX className="size-7 text-muted-foreground/60" />
      <div className="text-[13px] text-foreground">
        {translate(
          'auto.components.rightSidebar.CodePanel.notProjectTitle',
          'This folder is not a project yet'
        )}
      </div>
      <div className="max-w-[16rem] text-xs text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.CodePanel.notProjectCopy',
          'Code folders follow the project. Add this folder as a project to configure C++ / Python indexing here.'
        )}
      </div>
      <Button type="button" size="xs" className="gap-1.5" onClick={onAddAsProject}>
        <FolderInput className="size-3.5" />
        {translate(
          'auto.components.rightSidebar.CodePanel.addAsProject',
          'Add Folder as Project'
        )}
      </Button>
    </div>
  )
}
