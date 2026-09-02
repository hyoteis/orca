import React, { useState } from 'react'
import { ChevronRight, Folder, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import { normalizeScopeMemberPath } from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { joinPath } from '@/lib/path'
import {
  addCodeIntelligenceMembers,
  writeCodeIntelligenceScopeEdit
} from '@/lib/language-server/code-intelligence-scope-member-edit'
import { createRepositoryCodeIntelligenceScope } from '../settings/repository-code-intelligence-scope'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { CodePanelDirectoryLister } from './CodePanel'
import { useLazyDirectoryListing } from './use-lazy-directory-listing'

export type CodePanelAddFolderScopeSeed = {
  repoId: string
  repoName: string
  repoPath: string
  isFolder: boolean
  executionHostId: ExecutionHostId
}

const LANGUAGES: { language: CodeIntelligenceLanguage; key: string; fallback: string }[] = [
  {
    language: 'cpp',
    key: 'auto.components.rightSidebar.CodePanel.addFolderCppScope',
    fallback: 'C++ scope'
  },
  {
    language: 'python',
    key: 'auto.components.rightSidebar.CodePanel.addFolderPythonScope',
    fallback: 'Python scope'
  }
]

/** In-app tree picker (#71): system dialogs cannot browse SSH hosts. */
export function CodePanelAddFolderDialog({
  onOpenChange,
  scopes,
  scopeSeed,
  workspaceRootPath,
  listDirectory
}: {
  onOpenChange: (open: boolean) => void
  scopes: readonly CodeIntelligenceScope[]
  scopeSeed: CodePanelAddFolderScopeSeed | null
  workspaceRootPath: string
  listDirectory: CodePanelDirectoryLister
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [customPath, setCustomPath] = useState('')
  const [saving, setSaving] = useState(false)
  // Existing scopes default their language on; a scope-less first add forces a pick.
  const [languages, setLanguages] = useState<ReadonlySet<CodeIntelligenceLanguage>>(
    () => new Set(scopes.map((scope) => scope.language))
  )
  const { expandedDirs, pendingDirs, entriesByDir, errorByDir, toggleDir } =
    useLazyDirectoryListing(listDirectory)

  const handleAddCustomPath = (): void => {
    try {
      // Why: ~ and .. must be rejected here — members persist exactly as typed.
      const path = normalizeScopeMemberPath(customPath.trim())
      if (!isRuntimePathAbsolute(path)) {
        throw new Error('not-absolute')
      }
      setSelected(path)
      setCustomPath('')
    } catch {
      toast.error(
        translate(
          'settings.codeIntelligence.customPathInvalid',
          'Enter an absolute Host path (~ and .. are not expanded)'
        )
      )
    }
  }

  const handleAdd = async (): Promise<void> => {
    if (!selected || languages.size === 0 || !scopeSeed) {
      return
    }
    const selectedLanguages = LANGUAGES.filter((entry) => languages.has(entry.language))
    if (
      selectedLanguages.some((entry) => entry.language === 'python') &&
      isRuntimePathAbsolute(selected)
    ) {
      toast.error(
        translate(
          'auto.components.rightSidebar.CodePanel.addFolderPythonAbsolute',
          'Python code folders must stay relative to the workspace'
        )
      )
      return
    }
    setSaving(true)
    try {
      const writes = selectedLanguages
        .map((entry) => {
          const existing = scopes.find((scope) => scope.language === entry.language)
          const base =
            existing ??
            {
              ...createRepositoryCodeIntelligenceScope({ ...scopeSeed, language: entry.language }),
              members: []
            }
          const next = addCodeIntelligenceMembers(base, [selected])
          return next === base ? null : writeCodeIntelligenceScopeEdit(next)
        })
        .filter((write): write is Promise<boolean> => write !== null)
      await Promise.all(writes)
    } catch (error) {
      // Tree names like '~' fail member normalization; surface instead of sticking in saving.
      toast.error(
        extractIpcErrorMessage(
          error,
          translate(
            'auto.components.rightSidebar.CodePanel.addFolderFailed',
            'Could not add this folder'
          )
        )
      )
      setSaving(false)
      return
    }
    setSaving(false)
    onOpenChange(false)
  }

  const renderDirRow = (dirPath: string, relPath: string, depth: number): React.JSX.Element => (
    <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
      <button
        type="button"
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        aria-expanded={expandedDirs.has(dirPath)}
        aria-label={translate('settings.codeIntelligence.toggleFolderTree', 'Expand folder')}
        onClick={() => toggleDir(dirPath)}
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', expandedDirs.has(dirPath) && 'rotate-90')}
        />
      </button>
      <button
        type="button"
        aria-pressed={selected === relPath}
        className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left hover:bg-accent/50 aria-pressed:bg-accent"
        title={relPath}
        onClick={() => setSelected(relPath)}
      >
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {relPath.split('/').pop()}
        </span>
      </button>
    </div>
  )

  const renderDirChildren = (dirPath: string, relPath: string, depth: number): React.JSX.Element[] | null => {
    if (!expandedDirs.has(dirPath)) {
      return null
    }
    const entries = entriesByDir[dirPath]
    if (!entries) {
      if (errorByDir[dirPath]) {
        return [
          <div key={`${dirPath}\0error`} className="px-1.5 py-1 text-[11px] text-muted-foreground">
            {errorByDir[dirPath]}
          </div>
        ]
      }
      return pendingDirs.has(dirPath)
        ? [
            <div key={`${dirPath}\0pending`} className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {translate('auto.components.rightSidebar.CodePanel.loading', 'Loading…')}
            </div>
          ]
        : null
    }
    return entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => {
        const childDir = joinPath(dirPath, entry.name)
        const childRel = relPath === '.' ? entry.name : `${relPath}/${entry.name}`
        return (
          <React.Fragment key={childDir}>
            {renderDirRow(childDir, childRel, depth)}
            {renderDirChildren(childDir, childRel, depth + 1)}
          </React.Fragment>
        )
      })
  }

  const canConfirm = selected !== null && languages.size > 0 && scopeSeed !== null

  return (
    <Dialog open onOpenChange={(next) => !next && !saving && onOpenChange(false)}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-x-hidden overflow-y-auto scrollbar-sleek sm:w-[36rem] sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.rightSidebar.CodePanel.addFolderTitle',
              'Add Folder to Code Scopes'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.rightSidebar.CodePanel.addFolderDescription',
              'Pick a folder from the workspace tree, or enter an absolute Host path outside the workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <section className="rounded-md border border-border">
            <div className="max-h-64 overflow-y-auto p-1.5 scrollbar-sleek">
              {renderDirRow(workspaceRootPath, '.', 0)}
              {renderDirChildren(workspaceRootPath, '.', 1)}
            </div>
          </section>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={customPath}
              aria-label={translate(
                'settings.codeIntelligence.customPathPlaceholder',
                'Add a folder outside this workspace (Host absolute path)'
              )}
              placeholder={translate(
                'settings.codeIntelligence.customPathPlaceholder',
                'Add a folder outside this workspace (Host absolute path)'
              )}
              className="h-8 bg-background text-xs shadow-none"
              onChange={(event) => setCustomPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && customPath.trim()) {
                  event.preventDefault()
                  handleAddCustomPath()
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={!customPath.trim()}
              aria-label={translate(
                'settings.codeIntelligence.customPathPlaceholder',
                'Add a folder outside this workspace (Host absolute path)'
              )}
              onClick={handleAddCustomPath}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {LANGUAGES.map((entry) => (
              <label key={entry.language} className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
                <Checkbox
                  checked={languages.has(entry.language)}
                  aria-label={translate(entry.key, entry.fallback)}
                  onCheckedChange={(checked) =>
                    setLanguages((current) => {
                      const next = new Set(current)
                      if (checked === true) {
                        next.add(entry.language)
                      } else {
                        next.delete(entry.language)
                      }
                      return next
                    })
                  }
                />
                {translate(entry.key, entry.fallback)}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.CodePanel.addFolderPythonOnlyRelative',
              'Python accepts workspace-relative paths only.'
            )}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {translate('settings.codeIntelligence.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!canConfirm || saving} onClick={() => void handleAdd()}>
            {translate('auto.components.rightSidebar.CodePanel.addFolderConfirm', 'Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
