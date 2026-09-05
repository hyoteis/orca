import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  clangdCompileCommandsDirArg,
  type CodeIntelligenceCppSetupResult
} from '../../../../shared/code-intelligence-cpp-setup'
import { getCppScopeIdForRepo } from '../../../../shared/code-intelligence-scope'
import { writeCodeIntelligenceScopeEdit } from '@/lib/language-server/code-intelligence-scope-member-edit'
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
  useSetupScopeSelection,
  type SetupScopeSelectionMode
} from './code-intelligence-setup-scope-selection'

type ModalData = { repoId?: string }

export default function CodeIntelligenceCppSetupDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData as ModalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const repo = repos.find((candidate) => candidate.id === modalData.repoId) ?? null
  const [additionalIncludes, setAdditionalIncludes] = useState('')
  const [defines, setDefines] = useState('')
  const [cppStandard, setCppStandard] = useState<'c++17' | 'c++20' | 'c++23'>('c++17')
  const [stage, setStage] = useState<'idle' | 'running' | 'success'>('idle')
  const [result, setResult] = useState<CodeIntelligenceCppSetupResult | null>(null)
  const open = activeModal === 'code-intelligence-cpp-setup'
  const setupHost = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  const setupSupported = setupHost?.kind === 'local' || setupHost?.kind === 'ssh'
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const setupHostLabel = setupHost?.kind === 'ssh' ? (sshTargetLabels.get(setupHost.targetId) ?? setupHost.targetId) : ''
  const {
    mode,
    setMode,
    language,
    setLanguage,
    roots,
    selected,
    setSelected,
    directoryQuery,
    setDirectoryQuery,
    rescan,
    scanning,
    scanError,
    selectedRoots,
    pythonScopeId
  } = useSetupScopeSelection({ open, repo })

  useEffect(() => {
    if (!open) {
      return
    }
    setResult(null)
    setStage('idle')
  }, [open, repo?.id])

  useEffect(() => {
    if (scanError) {
      setResult(scanError)
    }
  }, [scanError])

  const runSetup = async (): Promise<void> => {
    if (!repo) {
      return
    }
    setStage('running')
    setResult(null)
    try {
      const setup = await window.api.codeIntelligence.setupCpp({
        repoId: repo.id,
        // Dual-form members: workspace-relative and host-absolute selections alike.
        relativeRoots: selectedRoots,
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
      const existing = settings?.codeIntelligenceScopes?.find(
        (scope) => scope.id === getCppScopeIdForRepo(repo)
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
          args: [clangdCompileCommandsDirArg(setup.compileCommandsDir)]
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

  /** Python needs no toolchain — persist folder members and close, like the
      removed add-folder dialog did. */
  const savePythonScope = async (): Promise<void> => {
    if (!repo || !pythonScopeId || selectedRoots.length === 0) {
      return
    }
    const existing = settings?.codeIntelligenceScopes?.find(
      (scope) => scope.id === pythonScopeId
    )
    const base =
      existing ??
      createRepositoryCodeIntelligenceScope({
        repoId: repo.id,
        repoName: repo.displayName,
        repoPath: repo.path,
        isFolder: isFolderRepo(repo),
        executionHostId: getRepoExecutionHostId(repo),
        language: 'python'
      })
    const saved = await writeCodeIntelligenceScopeEdit({
      ...base,
      members: selectedRoots.map((path) => ({ path, visibleResults: true }))
    })
    if (saved) {
      toast.success(
        translate('settings.codeIntelligence.pythonScopeSaved', 'Python folders saved')
      )
      closeModal()
    }
  }

  const runningText =
    scanning
      ? translate('settings.codeIntelligence.scanningBuildFolders', 'Scanning CMake and GN build folders...')
      : setupHost?.kind === 'ssh'
        ? translate('settings.codeIntelligence.runningSetupOnHost', 'Installing tools and generating compile commands on {{host}}...', { host: setupHostLabel })
        : translate('settings.codeIntelligence.runningSetup', 'Installing tools and generating compile commands...')

  if (!open || !repo) {
    return null
  }
  const busy = scanning || stage === 'running'
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && closeModal()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-x-hidden overflow-y-auto scrollbar-sleek sm:w-[36rem] sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {translate('settings.codeIntelligence.setupTitle', 'Configure code intelligence')}
          </DialogTitle>
          <DialogDescription>
            {language === 'python'
              ? translate(
                  'settings.codeIntelligence.pythonSetupDescription',
                  'Pick Python code folders. They stay relative to the workspace; no tools are installed.'
                )
              : setupHost?.kind === 'ssh'
                ? translate(
                    'settings.codeIntelligence.sshSetupDescription',
                    'Orca runs C++ setup on the connected SSH Host and installs missing tools there.'
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
              value={language}
              onChange={(value) => setLanguage(value as 'cpp' | 'python')}
              ariaLabel={translate(
                'settings.codeIntelligence.languageSelection',
                'Language scope'
              )}
              options={[
                { value: 'cpp', label: 'C++' },
                { value: 'python', label: 'Python' }
              ]}
            />
            <SettingsSegmentedControl
              value={mode}
              onChange={(value) => setMode(value as SetupScopeSelectionMode)}
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
                discovering={scanning}
                onQueryChange={setDirectoryQuery}
                onSelectedChange={setSelected}
                onRescan={rescan}
              />
            ) : null}
            {language === 'cpp' ? (
              <CodeIntelligenceBasicOptions
                additionalIncludes={additionalIncludes}
                defines={defines}
                cppStandard={cppStandard}
                onAdditionalIncludesChange={setAdditionalIncludes}
                onDefinesChange={setDefines}
                onCppStandardChange={setCppStandard}
              />
            ) : null}
            {busy ? (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" />
                {runningText}
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
            language === 'python' ? (
              <Button
                type="button"
                disabled={selectedRoots.length === 0}
                onClick={() => void savePythonScope()}
              >
                {translate('settings.codeIntelligence.saveFolders', 'Save')}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy || selectedRoots.length === 0}
                onClick={() => void runSetup()}
              >
                {translate('settings.codeIntelligence.generateEnable', 'Generate and enable')}
              </Button>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
