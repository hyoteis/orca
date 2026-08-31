import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { CodeIntelligenceCppSetupResult } from '../../../../shared/code-intelligence-cpp-setup'
import { listRuntimeFiles } from '../../runtime/runtime-file-client'
import { getCachedCodeIntelligenceDirectories } from '../../lib/language-server/code-intelligence-directory-scan-cache'
import { createRepositoryCodeIntelligenceScope } from '../settings/repository-code-intelligence-scope'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import { CodeIntelligenceBasicOptions } from './CodeIntelligenceBasicOptions'
import { CodeIntelligenceDirectoryPicker } from './CodeIntelligenceDirectoryPicker'
import {
  getCodeIntelligenceCustomPaths,
  getMinimalCodeIntelligenceDirectories
} from './code-intelligence-directory-list'

type SelectionMode = 'all' | 'selected'
type ModalData = { repoId?: string }

export default function CodeIntelligenceCppSetupDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData as ModalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const repo = repos.find((candidate) => candidate.id === modalData.repoId) ?? null
  const [mode, setMode] = useState<SelectionMode>('all')
  const [roots, setRoots] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [scanGeneration, setScanGeneration] = useState(0)
  const [additionalIncludes, setAdditionalIncludes] = useState('')
  const [defines, setDefines] = useState('')
  const [cppStandard, setCppStandard] = useState<'c++17' | 'c++20' | 'c++23'>('c++17')
  const [stage, setStage] = useState<'idle' | 'discovering' | 'running' | 'success'>('idle')
  const [result, setResult] = useState<CodeIntelligenceCppSetupResult | null>(null)
  const open = activeModal === 'code-intelligence-cpp-setup'
  const setupHost = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  const setupSupported = setupHost?.kind === 'local' || setupHost?.kind === 'ssh'

  useEffect(() => {
    if (!open) {
      return
    }
    setScanGeneration(0)
  }, [open, repo?.id])

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    let cancelled = false
    setMode('all')
    setDirectoryQuery('')
    setResult(null)
    setStage('discovering')
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    const executionHostId = getRepoExecutionHostId(repo)
    void getCachedCodeIntelligenceDirectories({
      key: `${executionHostId}:${repo.id}:${repo.path}`,
      force: scanGeneration > 0,
      loadFiles: () =>
        listRuntimeFiles(
          {
            settings: { ...settingsRef.current, activeRuntimeEnvironmentId: null },
            worktreeId: repo.id,
            worktreePath: repo.path,
            connectionId: repo.connectionId ?? undefined,
            expectedExecutionHostId:
              host?.kind === 'local' || host?.kind === 'ssh' ? host.id : undefined
          },
          { rootPath: repo.path }
        )
    })
      .then((detected) => {
        if (cancelled) {
          return
        }
        const workspaceKey = `${isFolderRepo(repo) ? 'folder' : 'worktree'}:${repo.id}`
        const existingMembers =
          settingsRef.current?.codeIntelligenceScopes
            ?.find(
              (scope) =>
                scope.workspaceKey === workspaceKey &&
                scope.executionHostId === getRepoExecutionHostId(repo) &&
                scope.language === 'cpp'
            )
            ?.members.map((member) => member.path) ?? []
        setRoots(detected)
        // Why: flat rows are literal members — pre-check exactly what the scope holds.
        setSelected(new Set(existingMembers))
        setStage('idle')
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setResult({
          ok: false,
          message: translate(
            'settings.codeIntelligence.buildScanFailed',
            'Could not scan C++ build folders'
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
  }, [open, repo, scanGeneration])

  const relativeSelectedRoots = useMemo(
    () =>
      mode === 'all'
        ? roots.includes('.')
          ? ['.']
          : roots
        : getMinimalCodeIntelligenceDirectories(roots, selected),
    [mode, roots, selected]
  )
  const customRoots = useMemo(
    () => getCodeIntelligenceCustomPaths(roots, selected),
    [roots, selected]
  )
  const selectedRoots = useMemo(
    () => [...relativeSelectedRoots, ...customRoots],
    [relativeSelectedRoots, customRoots]
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
        // Dual-form members: workspace-relative and host-absolute selections alike.
        relativeRoots: selectedRoots,
        workspaceDirectories: roots,
        installMissingTools: true,
        additionalIncludeDirectories: additionalIncludes
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
        defines: defines
          .split(/\r?\n/)
          .map((define) => define.trim())
          .filter(Boolean),
        cppStandard
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
        members: setup.relativeRoots.map((path) => ({
          path,
          visibleResults: true
        })),
        serverSource: {
          type: 'custom',
          executable: setup.clangdExecutable,
          args: [`--compile-commands-dir=${setup.compileCommandsDir}`]
        },
        enabled: true,
        ...(setup.configurationMode && setup.healthState
          ? {
              setupStatus: {
                state: setup.healthState,
                mode: setup.configurationMode,
                generatedAt: Date.now(),
                compileCommandCount: setup.compileCommandCount,
                warningCount: setup.warnings?.length ?? 0,
                message: setup.warnings?.[0],
                compileCommandsDir: setup.compileCommandsDir
              }
            }
          : {})
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
            {translate('settings.codeIntelligence.setupTitle', 'Configure C++ code intelligence')}
          </DialogTitle>
          <DialogDescription>
            {setupHost?.kind === 'ssh'
              ? translate(
                  'settings.codeIntelligence.sshSetupDescription',
                  'Orca generates a BASIC compilation database on the connected SSH Host. clangd must already be installed there.'
                )
              : translate(
                  'settings.codeIntelligence.setupDescription',
                  'Orca installs missing tools and generates compile commands. Source files are not modified.'
                )}
          </DialogDescription>
        </DialogHeader>

        {!setupSupported ? (
          <div
            className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {translate(
              'settings.codeIntelligence.setupUnsupportedHost',
              'Code intelligence setup currently supports local and SSH Hosts.'
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
              <CodeIntelligenceDirectoryPicker
                directories={roots}
                selected={selected}
                query={directoryQuery}
                discovering={stage === 'discovering'}
                onQueryChange={setDirectoryQuery}
                onSelectedChange={setSelected}
                onRescan={() => setScanGeneration((value) => value + 1)}
              />
            ) : null}
            <CodeIntelligenceBasicOptions
              additionalIncludes={additionalIncludes}
              defines={defines}
              cppStandard={cppStandard}
              onAdditionalIncludesChange={setAdditionalIncludes}
              onDefinesChange={setDefines}
              onCppStandardChange={setCppStandard}
            />
            {busy ? (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" />
                {stage === 'discovering'
                  ? translate(
                      'settings.codeIntelligence.scanningBuildFolders',
                      'Scanning CMake and GN build folders...'
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
                {result?.healthState === 'limited'
                  ? translate(
                      'settings.codeIntelligence.setupLimited',
                      'Configured with limited BASIC indexing'
                    )
                  : translate(
                      'settings.codeIntelligence.setupReady',
                      'C++ code intelligence is ready'
                    )}
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
          {setupSupported && stage !== 'success' ? (
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
