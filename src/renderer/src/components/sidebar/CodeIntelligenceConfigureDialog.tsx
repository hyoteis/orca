import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, Folder, FolderSearch, PauseCircle, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import { SshCompileDatabasePicker } from './SshCompileDatabasePicker'
import { ConfigureCodeFolders } from './ConfigureCodeFolders'
import { parentPath } from './remote-file-browser-helpers'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getCppSession } from '@/lib/language-server/cpp-code-intelligence-session'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getCppScopeIdForRepo } from '../../../../shared/code-intelligence-scope'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import type {
  AggregateMappingHealthSnapshot,
  CodeIntelligenceBasicOptions,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'


// Workspace-level Configure Code (#138, prototype dc25adf928 iteration 3):
// one row, one mode — a supplied compile_commands.json or BASIC indexing for
// the whole workspace. The per-folder contract stays in the persisted model
// as a backend guardrail; this UI never splits the workspace.

type ModalData = { repoId?: string }

type ConfigureMode = 'cdb' | 'basic'

export default function CodeIntelligenceConfigureDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData as ModalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const repo = repos.find((candidate) => candidate.id === modalData.repoId) ?? null
  const open = activeModal === 'code-intelligence-cpp-setup'

  const existingScope = useMemo<CodeIntelligenceScope | null>(() => {
    if (!repo) {
      return null
    }
    return settings?.codeIntelligenceScopes?.find((scope) => scope.id === getCppScopeIdForRepo(repo)) ?? null
  }, [repo, settings])

  const persistedMode: ConfigureMode =
    existingScope && existingScope.members.some((member) => member.compileDatabase !== undefined)
      ? 'cdb'
      : 'basic'
  const [mode, setMode] = useState<ConfigureMode>(persistedMode)
  const [cdbPath, setCdbPath] = useState(existingScope?.members[0]?.compileDatabase ?? '')
  const [includeText, setIncludeText] = useState((existingScope?.basicOptions?.includeDirectories ?? []).join('\n'))
  const [definesText, setDefinesText] = useState((existingScope?.basicOptions?.defines ?? []).join('\n'))
  const [cppStandard, setCppStandard] = useState<'c++17' | 'c++20' | 'c++23'>(
    existingScope?.basicOptions?.cppStandard ?? 'c++17'
  )
  const [mappings, setMappings] = useState<readonly AggregateMappingHealthSnapshot[] | null>(null)
  const [entryCount, setEntryCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  // #141: inline SSH browser target — the CDB picker or the directory picker.
  const [sshBrowsing, setSshBrowsing] = useState<'database' | 'directory' | null>(null)
  // #141: member folders the dialog manages; '.' = whole workspace.
  const [folders, setFolders] = useState<string[]>(
    existingScope?.members.map((member) => member.path) ?? ['.']
  )

  useEffect(() => {
    if (!open) {
      return
    }
    setMappings(null)
    setEntryCount(null)
    setBusy(false)
    setSshBrowsing(null)
    setFolders(existingScope?.members.map((member) => member.path) ?? ['.'])
    // existingScope intentionally omitted: only a repo switch re-seeds the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo?.id])

  const setupHost = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  const isSsh = setupHost?.kind === 'ssh'

  // Structure change = mode flip, a different database, or a different folder
  // set: saving it demands reauthorization (the consent fingerprint covers
  // exactly these fields).
  const persistedFolders = existingScope?.members.map((member) => member.path) ?? ['.']
  const foldersChanged =
    folders.length !== persistedFolders.length ||
    folders.slice().sort().join('|') !== persistedFolders.slice().sort().join('|')
  const structureChanged =
    foldersChanged ||
    mode !== persistedMode ||
    (mode === 'cdb' && cdbPath !== (existingScope?.members[0]?.compileDatabase ?? ''))

  // #141: picked folders must live inside the workspace (spec §1).
  const addPickedFolder = (absolutePath: string): void => {
    const relative = relativePathInsideRoot(repo!.path, absolutePath)
    if (relative === null) {
      toast.error(
        translate(
          'settings.codeIntelligence.folderOutsideWorkspace',
          'Code folders must live inside the workspace'
        )
      )
      return
    }
    const folder = relative === '' ? '.' : relative.replace(/\\/g, '/')
    setFolders((current) => (current.includes(folder) ? current : [...current, folder]))
  }

  const pickLocalFolder = async (): Promise<void> => {
    const picked = await window.api.shell.pickDirectory({ defaultPath: repo!.path })
    if (picked) {
      addPickedFolder(picked)
    }
  }

  const save = async (): Promise<void> => {
    if (!repo || busy) {
      return
    }
    setBusy(true)
    try {
      const basicOptions: CodeIntelligenceBasicOptions | undefined =
        mode === 'basic'
          ? {
              includeDirectories: includeText.split('\n').map((line) => line.trim()).filter(Boolean),
              defines: definesText.split('\n').map((line) => line.trim()).filter(Boolean),
              ...(cppStandard !== 'c++17' ? { cppStandard } : {})
            }
          : undefined
      const result = await window.api.codeIntelligence.configureAggregate({
        repoId: repo.id,
        mode,
        folders,
        ...(mode === 'cdb' ? { compileDatabase: cdbPath.trim() } : {}),
        ...(basicOptions ? { basicOptions } : {})
      })
      setMappings(result.mappings)
      setEntryCount(result.entryCount)
      await fetchSettings()
      toast.success(
        translate('settings.codeIntelligence.configureSaved', 'C++ code intelligence configured and authorized')
      )
      closeModal()
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, translate('settings.codeIntelligence.configureFailed', 'Configuration failed')))
    } finally {
      setBusy(false)
    }
  }

  const revalidate = async (): Promise<void> => {
    if (!repo || busy) {
      return
    }
    setBusy(true)
    try {
      const result = await window.api.codeIntelligence.revalidateAggregate({ repoId: repo.id })
      setMappings(result.mappings)
      setEntryCount(result.entryCount)
      toast.success(translate('settings.codeIntelligence.revalidated', 'Re-validated and reloaded'))
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, translate('settings.codeIntelligence.configureFailed', 'Configuration failed')))
    } finally {
      setBusy(false)
    }
  }

  // #149: health-only aggregate rebuilds never restart the running clangd —
  // this is the user's manual escape hatch for a stale session.
  const restartSession = (): void => {
    if (!existingScope || busy) {
      return
    }
    getCppSession().restartSession(existingScope.id, existingScope.revision)
    toast.success(translate('settings.codeIntelligence.restarted', 'C++ session restarted'))
  }

  const browse = async (): Promise<void> => {
    // SSH browses the remote host (spec §2 Step 5); local keeps the native pick.
    if (isSsh) {
      setSshBrowsing('database')
      return
    }
    const picked = await window.api.shell.pickCompileDatabase()
    if (picked) {
      setCdbPath(picked)
    }
  }

  if (!open) {
    return null
  }
  if (!repo || !(setupHost?.kind === 'local' || setupHost?.kind === 'ssh')) {
    return null
  }

  const statusChip = mappings?.length
    ? mappings[0].state === 'ok'
      ? { label: translate('settings.codeIntelligence.cdbValid', 'Valid'), tone: 'ok' as const }
      : mappings[0].state === 'degraded'
        ? { label: translate('settings.codeIntelligence.cdbDegraded', 'Degraded — last valid kept'), tone: 'warn' as const }
        : { label: translate('settings.codeIntelligence.cdbPartial', 'Partial coverage'), tone: 'warn' as const }
    : null

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && closeModal()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-y-auto scrollbar-sleek sm:w-[36rem] sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>{translate('settings.codeIntelligence.configureTitle', 'Configure C++ code intelligence')}</DialogTitle>
          <DialogDescription>
            {isSsh
              ? translate(
                  'settings.codeIntelligence.configureDescriptionSsh',
                  'One mode for the whole workspace: a supplied compile_commands.json anywhere on the remote Host, or BASIC indexing. The database must share the workspace\u2019s execution Host.'
                )
              : translate(
                  'settings.codeIntelligence.configureDescriptionLocal',
                  'One mode for the whole workspace: a supplied compile_commands.json anywhere on this machine, or BASIC indexing.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{repo.displayName}</span>
            <SettingsSegmentedControl
              value={mode}
              onChange={(value) => setMode(value as ConfigureMode)}
              ariaLabel={translate('settings.codeIntelligence.configureMode', 'Mode')}
              options={[
                { value: 'cdb', label: translate('settings.codeIntelligence.modeCdb', 'Compile database') },
                { value: 'basic', label: 'BASIC' }
              ]}
            />
            {statusChip ? (
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  statusChip.tone === 'ok'
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                }`}
              >
                {statusChip.tone === 'ok' ? <CheckCircle2 className="size-3" aria-hidden /> : <PauseCircle className="size-3" aria-hidden />}
                {statusChip.label}
              </span>
            ) : null}
          </div>

          {/* #141: member folder management — the mode applies to every folder. */}
          <ConfigureCodeFolders
            folders={folders}
            onChange={setFolders}
            onAddFolder={() => (isSsh ? setSshBrowsing('directory') : void pickLocalFolder())}
            sshPicker={
              sshBrowsing === 'directory' && isSsh && setupHost ? (
                <SshCompileDatabasePicker
                  select="directory"
                  targetId={setupHost.targetId}
                  initialPath={repo.path}
                  onPick={(path) => {
                    addPickedFolder(path)
                    setSshBrowsing(null)
                  }}
                  onCancel={() => setSshBrowsing(null)}
                />
              ) : null
            }
          />

          {mode === 'cdb' ? (
            <div className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Database className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
                  value={cdbPath}
                  placeholder={isSsh ? '/home/user/build/compile_commands.json' : 'D:\\build\\compile_commands.json'}
                  aria-label={translate('settings.codeIntelligence.cdbPathLabel', 'Database path')}
                  onChange={(event) => setCdbPath(event.target.value)}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
                  <FolderSearch className="size-3.5" aria-hidden />
                  {translate('settings.codeIntelligence.cdbBrowse', 'Browse…')}
                </Button>
              </div>
              {sshBrowsing === 'database' && isSsh && setupHost ? (
                <SshCompileDatabasePicker
                  targetId={setupHost.targetId}
                  initialPath={
                    existingScope?.members[0]?.compileDatabase
                      ? parentPath(existingScope.members[0].compileDatabase)
                      : '~'
                  }
                  onPick={(path) => {
                    setCdbPath(path)
                    setSshBrowsing(null)
                  }}
                  onCancel={() => setSshBrowsing(null)}
                />
              ) : null}
              {mappings?.length ? (
                <div
                  className={`flex items-start gap-1.5 text-[11px] leading-snug ${
                    mappings[0].state === 'ok' ? 'text-status-success' : 'text-amber-600 dark:text-amber-400'
                  }`}
                  role="status"
                  data-configure-status={mappings[0].state}
                >
                  {mappings[0].state === 'ok' ? <CheckCircle2 className="mt-0.5 size-3 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />}
                  <span>
                    {translate(
                      'settings.codeIntelligence.cdbEntryCount',
                      '{{count}} commands merged',
                      { count: entryCount ?? 0 }
                    )}
                    {mappings[0].state === 'warning'
                      ? ` · ${translate('settings.codeIntelligence.cdbCoverageWarning', 'not all workspace sources are covered — clangd infers the rest, never blocking')}`
                      : ''}
                    {mappings[0].state === 'degraded'
                      ? ` · ${translate('settings.codeIntelligence.cdbDegradedNote', 'last-valid entries keep serving; restore the file to re-merge automatically')}`
                      : ''}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void revalidate()} disabled={busy || !existingScope}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  {translate('settings.codeIntelligence.revalidate', 'Re-validate and reload')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={restartSession} disabled={busy || !existingScope}>
                  <RotateCcw className="size-3.5" aria-hidden />
                  {translate('settings.codeIntelligence.restartSession', 'Restart C++ session')}
                </Button>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {translate(
                  'settings.codeIntelligence.cdbAutoRefreshNote',
                  'Content changes refresh automatically without reauthorization; switching mode or database is a structure change and reauthorizes on save.'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-2.5 px-3 py-2.5">
              <label className="block text-[11px] text-muted-foreground" htmlFor="configure-includes">
                {translate('settings.codeIntelligence.basicIncludes', 'Include directories (one -I per line)')}
              </label>
              <textarea
                id="configure-includes"
                className="min-h-14 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                value={includeText}
                onChange={(event) => setIncludeText(event.target.value)}
              />
              <label className="block text-[11px] text-muted-foreground" htmlFor="configure-defines">
                {translate('settings.codeIntelligence.basicDefines', 'Defines (one -D per line)')}
              </label>
              <textarea
                id="configure-defines"
                className="min-h-10 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
                value={definesText}
                onChange={(event) => setDefinesText(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-foreground" htmlFor="configure-standard">
                  {translate('settings.codeIntelligence.basicStandard', 'C++ standard')}
                </label>
                <select
                  id="configure-standard"
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  value={cppStandard}
                  onChange={(event) => setCppStandard(event.target.value as 'c++17' | 'c++20' | 'c++23')}
                >
                  <option value="c++17">C++17</option>
                  <option value="c++20">C++20</option>
                  <option value="c++23">C++23</option>
                </select>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {translate(
                  'settings.codeIntelligence.basicNote',
                  'Applies to the whole workspace; the compile-database mode ignores these options.'
                )}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {structureChanged ? (
            <span className="mr-auto max-w-56 text-[11px] leading-snug text-muted-foreground">
              {translate(
                'settings.codeIntelligence.structureChanged',
                'Structure changed — saving will request reauthorization'
              )}
            </span>
          ) : null}
          <Button type="button" variant="outline" disabled={busy} onClick={closeModal}>
            {translate('settings.codeIntelligence.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy || folders.length === 0 || (mode === 'cdb' && cdbPath.trim() === '')}
            onClick={() => void save()}
          >
            {translate('settings.codeIntelligence.saveAndAuthorize', 'Save and authorize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
