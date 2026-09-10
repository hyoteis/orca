import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, Folder, FolderSearch, LoaderCircle, PauseCircle, Power, RefreshCw, TriangleAlert } from 'lucide-react'
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
import { ConfigureBasicOptionsForm } from './ConfigureBasicOptionsForm'
import { parentPath } from './remote-file-browser-helpers'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { restartCppSession } from '@/lib/language-server/cpp-code-intelligence-requests'
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
  const [busyOperation, setBusyOperation] = useState<'save' | 'revalidate' | null>(null)
  const busy = busyOperation !== null
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
    setBusyOperation(null)
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
    setBusyOperation('save')
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
      setBusyOperation(null)
    }
  }

  const revalidate = async (): Promise<void> => {
    if (!repo || busy) {
      return
    }
    setBusyOperation('revalidate')
    try {
      const result = await window.api.codeIntelligence.revalidateAggregate({ repoId: repo.id })
      setMappings(result.mappings)
      setEntryCount(result.entryCount)
      toast.success(translate('settings.codeIntelligence.revalidated', 'Re-validated and reloaded'))
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, translate('settings.codeIntelligence.configureFailed', 'Configuration failed')))
    } finally {
      setBusyOperation(null)
    }
  }

  // #149: health-only pushes keep the running clangd alive, so a rebuilt
  // aggregate needs this manual drop; the next editor request reopens.
  const restartSession = (): void => {
    if (!existingScope) {
      return
    }
    const restarted = restartCppSession(existingScope.id, existingScope.revision)
    toast.success(
      restarted
        ? translate(
            'settings.codeIntelligence.sessionRestarted',
            'C++ session restarted — reopens on next use'
          )
        : translate('settings.codeIntelligence.sessionNotRunning', 'No running C++ session')
    )
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
      <DialogContent
        aria-busy={busyOperation === 'save'}
        className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-y-auto scrollbar-sleek sm:w-[36rem] sm:max-w-[36rem]"
      >
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
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void revalidate()} disabled={busy || !existingScope}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  {translate('settings.codeIntelligence.revalidate', 'Re-validate and reload')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={restartSession} disabled={busy || !existingScope}>
                  <Power className="size-3.5" aria-hidden />
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
            <ConfigureBasicOptionsForm
              includeText={includeText}
              definesText={definesText}
              cppStandard={cppStandard}
              onIncludeChange={setIncludeText}
              onDefinesChange={setDefinesText}
              onStandardChange={setCppStandard}
            />
          )}
        </div>

        <DialogFooter>
          {busyOperation === 'save' ? (
            <span
              className="mr-auto flex max-w-56 items-center gap-1.5 text-[11px] leading-snug text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
              {translate(
                'settings.codeIntelligence.configuringAndAuthorizing',
                'Configuring and authorizing C++ code intelligence…'
              )}
            </span>
          ) : structureChanged ? (
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
            aria-busy={busyOperation === 'save'}
            disabled={busy || folders.length === 0 || (mode === 'cdb' && cdbPath.trim() === '')}
            onClick={() => void save()}
          >
            {busyOperation === 'save' ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            {translate('settings.codeIntelligence.saveAndAuthorize', 'Save and authorize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
