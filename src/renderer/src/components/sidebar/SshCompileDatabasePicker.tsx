import React, { useCallback, useEffect, useState } from 'react'
import { ArrowUp, FileJson, Folder, FolderCheck, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { joinPath, parentPath, type DirEntry } from './remote-file-browser-helpers'
import type { FilesystemPathFlavor } from '../../../../shared/types'

/** Remote-host compile_commands.json picker (#138 spec §2 Step 5: "SSH
 * browses the remote host"). Directories navigate, JSON files pick; select=
 * 'directory' (#141) picks the current directory instead. */
export function SshCompileDatabasePicker({
  targetId,
  initialPath,
  select = 'database',
  onPick,
  onCancel
}: {
  targetId: string
  initialPath: string
  select?: 'database' | 'directory'
  onPick: (path: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [dir, setDir] = useState(initialPath)
  const [entries, setEntries] = useState<readonly DirEntry[]>([])
  const [pathFlavor, setPathFlavor] = useState<FilesystemPathFlavor>('posix')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (dirPath: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.ssh.browseDir({ targetId, dirPath })
        setEntries(result.entries)
        setDir(result.resolvedPath)
        setPathFlavor(result.pathFlavor)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [targetId]
  )

  useEffect(() => {
    void load(initialPath)
    // Only the initial path and explicit navigation trigger loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId])

  const directories = entries.filter((entry) => entry.isDirectory)
  const databases =
    select === 'directory' ? [] : entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))

  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-ssh-cdb-picker>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {select === 'directory'
            ? translate('settings.codeIntelligence.sshDirectoryPickerTitle', 'Select a folder')
            : translate('settings.codeIntelligence.sshPickerTitle', 'Select compile_commands.json')}
        </span>
        <div className="flex items-center gap-1">
          {select === 'directory' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onPick(dir)}
              disabled={loading}
            >
              <FolderCheck className="size-3" aria-hidden />
              {translate('settings.codeIntelligence.selectThisDirectory', 'Use this folder')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label={translate('settings.codeIntelligence.cancel', 'Cancel')}
            onClick={onCancel}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {select === 'directory'
          ? translate(
              'settings.codeIntelligence.sshDirectoryPickerDescription',
              'Navigate the Host and pick a code folder inside the workspace.'
            )
          : translate(
              'settings.codeIntelligence.sshPickerDescription',
              'Navigate the Host and pick a compile database.'
            )}
      </p>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => void load(parentPath(dir, pathFlavor))}
              disabled={loading || dir === '/'}
              aria-label={translate('settings.codeIntelligence.sshPickerUp', 'Parent directory')}
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('settings.codeIntelligence.sshPickerUp', 'Parent directory')}
          </TooltipContent>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{dir}</span>
      </div>
      <div className="min-h-32 rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {translate('settings.codeIntelligence.sshPickerLoading', 'Loading…')}
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-destructive">{error}</div>
        ) : directories.length + databases.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">
            {translate('settings.codeIntelligence.sshPickerEmpty', 'No directories or JSON files')}
          </div>
        ) : (
          <ul className="max-h-64 overflow-y-auto scrollbar-sleek p-1">
            {directories.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => void load(joinPath(dir, entry.name, pathFlavor))}
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {entry.name}
                </button>
              </li>
            ))}
            {databases.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => onPick(joinPath(dir, entry.name, pathFlavor))}
                >
                  <FileJson className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {select === 'directory'
          ? translate(
              'settings.codeIntelligence.sshDirectoryPickerNote',
              'The folder must live inside the workspace on this Host.'
            )
          : translate(
              'settings.codeIntelligence.sshPickerNote',
              'Only JSON files are listed; the database must live on this Host.'
            )}
      </p>
    </div>
  )
}
