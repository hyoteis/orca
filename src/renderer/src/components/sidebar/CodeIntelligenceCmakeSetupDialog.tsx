import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { CodeIntelligenceCmakeSetupResult } from '../../../../shared/code-intelligence-cmake-setup'
import { listRuntimeFiles } from '../../runtime/runtime-file-client'
import { discoverCodeIntelligenceCandidates } from '../../lib/language-server/code-intelligence-scope-discovery'
import { createRepositoryCodeIntelligenceScope } from '../settings/repository-code-intelligence-scope'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'

type SelectionMode = 'all' | 'selected'
type ModalData = { repoId?: string }

export default function CodeIntelligenceCmakeSetupDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData as ModalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const repo = repos.find((candidate) => candidate.id === modalData.repoId) ?? null
  const [mode, setMode] = useState<SelectionMode>('all')
  const [roots, setRoots] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stage, setStage] = useState<'idle' | 'discovering' | 'running' | 'success'>('idle')
  const [result, setResult] = useState<CodeIntelligenceCmakeSetupResult | null>(null)
  const open = activeModal === 'code-intelligence-cmake-setup'
  const local = repo ? getRepoExecutionHostId(repo) === 'local' : false

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    let cancelled = false
    setMode('all')
    setResult(null)
    setStage('discovering')
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    void listRuntimeFiles(
      {
        settings: { ...settings, activeRuntimeEnvironmentId: null },
        worktreeId: repo.id,
        worktreePath: repo.path,
        connectionId: repo.connectionId ?? undefined,
        expectedExecutionHostId:
          host?.kind === 'local' || host?.kind === 'ssh' ? host.id : undefined
      },
      { rootPath: repo.path }
    )
      .then((files) => {
        if (cancelled) {
          return
        }
        const detected = discoverCodeIntelligenceCandidates(files)
          .filter(
            (candidate) =>
              candidate.languages.includes('cpp') && candidate.markers.includes('CMakeLists.txt')
          )
          .map((candidate) => candidate.relativeRoot)
        setRoots(detected)
        setSelected(new Set())
        setStage('idle')
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setResult({
          ok: false,
          message: translate(
            'settings.codeIntelligence.scanFailed',
            'Could not scan CMake folders'
          ),
          log: error instanceof Error ? (error.stack ?? error.message) : String(error),
          relativeRoots: [],
          installedTools: []
        })
        setStage('idle')
      })
    return () => {
      cancelled = true
    }
  }, [open, repo, settings])

  const selectedRoots = useMemo(
    () => (mode === 'all' ? ['.'] : roots.filter((root) => selected.has(root))),
    [mode, roots, selected]
  )

  const runSetup = async (): Promise<void> => {
    if (!repo) {
      return
    }
    setStage('running')
    setResult(null)
    try {
      const setupCpp = window.api.codeIntelligence.setupCpp
      if (typeof setupCpp !== 'function') {
        setResult({
          ok: false,
          message: translate(
            'settings.codeIntelligence.restartRequired',
            'Restart the Orca test app to load the updated setup bridge.'
          ),
          log: 'The renderer loaded the new setup UI with an older Electron preload. Restart Orca and try again.',
          relativeRoots: selectedRoots,
          installedTools: []
        })
        setStage('idle')
        return
      }
      const setup = await setupCpp({
        repoId: repo.id,
        relativeRoots: selectedRoots,
        installMissingTools: true
      })
      setResult(setup)
      if (!setup.ok || !setup.clangdExecutable || !setup.compileCommandsDir) {
        setStage('idle')
        return
      }
      const executionHostId = getRepoExecutionHostId(repo)
      const workspaceKey = `${isFolderRepo(repo) ? 'folder' : 'worktree'}:${repo.id}` as const
      const existing = settings?.codeIntelligenceScopes?.find(
        (scope) =>
          scope.workspaceKey === workspaceKey &&
          scope.executionHostId === executionHostId &&
          scope.language === 'cpp'
      )
      const base =
        existing ??
        createRepositoryCodeIntelligenceScope({
          repoId: repo.id,
          repoName: repo.displayName,
          repoPath: repo.path,
          isFolder: isFolderRepo(repo),
          executionHostId,
          language: 'cpp'
        })
      const saved = await window.api.codeIntelligence.upsertScope({
        ...base,
        members: setup.relativeRoots.map((relativePath) => ({
          relativePath,
          visibleResults: true
        })),
        serverSource: {
          type: 'custom',
          executable: setup.clangdExecutable,
          args: [`--compile-commands-dir=${setup.compileCommandsDir}`]
        },
        enabled: true
      })
      await window.api.codeIntelligence.grantConsent({
        scopeId: saved.id,
        revision: saved.revision
      })
      await fetchSettings()
      setStage('success')
      toast.success(
        translate('settings.codeIntelligence.setupComplete', 'C++ setup generated and enabled')
      )
    } catch (error) {
      setResult({
        ok: false,
        message: translate('settings.codeIntelligence.setupFailed', 'C++ setup failed'),
        log: error instanceof Error ? (error.stack ?? error.message) : String(error),
        relativeRoots: selectedRoots,
        installedTools: []
      })
      setStage('idle')
    }
  }

  if (!open || !repo) {
    return null
  }
  const busy = stage === 'discovering' || stage === 'running'
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && closeModal()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-x-hidden overflow-y-auto scrollbar-sleek sm:w-[36rem] sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {translate('settings.codeIntelligence.setupTitle', 'Set up C++ code intelligence')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'settings.codeIntelligence.setupDescription',
              'Orca installs missing tools and generates compile commands in its cache. Project files are not modified.'
            )}
          </DialogDescription>
        </DialogHeader>

        {!local ? (
          <div
            className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {translate(
              'settings.codeIntelligence.localOnly',
              'One-click setup currently supports local Hosts. Configure this Host from project settings.'
            )}
          </div>
        ) : (
          <div className="min-w-0 space-y-4">
            <SettingsSegmentedControl
              value={mode}
              onChange={(value) => setMode(value as SelectionMode)}
              ariaLabel={translate('settings.codeIntelligence.scopeSelection', 'Scope selection')}
              options={[
                {
                  value: 'all',
                  label: translate('settings.codeIntelligence.wholeProject', 'Whole project')
                },
                {
                  value: 'selected',
                  label: translate('settings.codeIntelligence.selectedFolders', 'Selected folders')
                }
              ]}
            />
            {mode === 'selected' ? (
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-3 scrollbar-sleek">
                {roots.length === 0 && stage !== 'discovering' ? (
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'settings.codeIntelligence.noCmakeFolders',
                      'No CMake folders were detected.'
                    )}
                  </p>
                ) : null}
                {roots.map((root) => (
                  <Label
                    key={root}
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    <Checkbox
                      checked={selected.has(root)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (checked) {
                            next.add(root)
                          } else {
                            next.delete(root)
                          }
                          return next
                        })
                      }
                    />
                    <span className="truncate">{root}</span>
                  </Label>
                ))}
              </div>
            ) : null}
            {busy ? (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" />
                {stage === 'discovering'
                  ? translate(
                      'settings.codeIntelligence.scanningFolders',
                      'Scanning CMake folders...'
                    )
                  : translate(
                      'settings.codeIntelligence.runningSetup',
                      'Installing tools and generating compile commands...'
                    )}
              </div>
            ) : null}
            {stage === 'success' ? (
              <div className="flex items-center gap-2 text-sm text-foreground" role="status">
                <CheckCircle2 className="size-4 text-success" />
                {result?.message}
              </div>
            ) : null}
            {result && !result.ok ? (
              <div
                className="min-w-0 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                role="alert"
              >
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{result.message}</span>
                </div>
                <pre className="box-border max-h-48 w-full min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs scrollbar-sleek">
                  {result.log ||
                    translate('settings.codeIntelligence.noSetupLog', 'No setup log was produced.')}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void window.api.ui.writeClipboardText(result.log)}
                >
                  <Copy className="size-3.5" />
                  {translate('settings.codeIntelligence.copySetupLog', 'Copy log')}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={closeModal}>
            {stage === 'success'
              ? translate('settings.codeIntelligence.done', 'Done')
              : translate('settings.codeIntelligence.cancel', 'Cancel')}
          </Button>
          {local && stage !== 'success' ? (
            <Button
              type="button"
              disabled={busy || selectedRoots.length === 0}
              onClick={() => void runSetup()}
            >
              {translate('settings.codeIntelligence.generateEnable', 'Generate and enable')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
