import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { CodeIntelligenceCppSetupResult } from '../../../../shared/code-intelligence-cpp-setup'
import {
  getCodeIntelligenceScopeId,
  getCodeIntelligenceWorkspaceKey,
  getCppScopeIdForRepo,
  type CodeIntelligenceLanguage
} from '../../../../shared/code-intelligence-scope'
import { listRuntimeFiles } from '../../runtime/runtime-file-client'
import { getCachedCodeIntelligenceDirectories } from '../../lib/language-server/code-intelligence-directory-scan-cache'
import {
  getCodeIntelligenceCustomPaths,
  getMinimalCodeIntelligenceDirectories
} from './code-intelligence-directory-list'

export type SetupScopeSelectionMode = 'all' | 'selected'

/** Directory scan + language/folder selection state for the code-intelligence
 *  setup dialog — one hook so the dialog body stays under max-lines. */
export function useSetupScopeSelection({ open, repo }: { open: boolean; repo: Repo | null }): {
  mode: SetupScopeSelectionMode
  setMode: (mode: SetupScopeSelectionMode) => void
  language: CodeIntelligenceLanguage
  setLanguage: (language: CodeIntelligenceLanguage) => void
  roots: string[]
  selected: Set<string>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  directoryQuery: string
  setDirectoryQuery: (query: string) => void
  rescan: () => void
  scanning: boolean
  scanError: CodeIntelligenceCppSetupResult | null
  selectedRoots: string[]
  pythonScopeId: string | null
} {
  const settings = useAppStore((state) => state.settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [mode, setMode] = useState<SetupScopeSelectionMode>('all')
  const [language, setLanguage] = useState<CodeIntelligenceLanguage>('cpp')
  const [roots, setRoots] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [scanGeneration, setScanGeneration] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<CodeIntelligenceCppSetupResult | null>(null)
  const pythonScopeId = useMemo(
    () =>
      repo
        ? getCodeIntelligenceScopeId({
            executionHostId: getRepoExecutionHostId(repo),
            workspaceKey: getCodeIntelligenceWorkspaceKey(repo.id, isFolderRepo(repo)),
            language: 'python'
          })
        : null,
    [repo]
  )

  useEffect(() => {
    if (!open) {
      return
    }
    setScanGeneration(0)
    setLanguage('cpp')
  }, [open, repo?.id])

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    let cancelled = false
    setMode('all')
    setDirectoryQuery('')
    setScanError(null)
    setScanning(true)
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
        setRoots(detected)
        setScanning(false)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setScanError({
          ok: false,
          message: translate(
            'settings.codeIntelligence.buildScanFailed',
            'Could not scan C++ build folders'
          ),
          log: error instanceof Error ? (error.stack ?? error.message) : String(error),
          relativeRoots: [],
          installedTools: []
        })
        setScanning(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, repo, scanGeneration])

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    // Why: tree rows map 1:1 to members — pre-check exactly what the language scope holds.
    const scopeId = language === 'cpp' ? getCppScopeIdForRepo(repo) : pythonScopeId
    const members =
      settingsRef.current?.codeIntelligenceScopes?.find((scope) => scope.id === scopeId)?.members ??
      []
    setSelected(new Set(members.map((member) => member.path)))
  }, [open, repo, language, pythonScopeId])

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
  // Why: python members must stay workspace-relative; host-absolute picks are cpp-only.
  const selectedRoots = useMemo(
    () => (language === 'python' ? relativeSelectedRoots : [...relativeSelectedRoots, ...customRoots]),
    [language, relativeSelectedRoots, customRoots]
  )

  return {
    mode,
    setMode,
    language,
    setLanguage,
    roots,
    selected,
    setSelected,
    directoryQuery,
    setDirectoryQuery,
    rescan: () => setScanGeneration((value) => value + 1),
    scanning,
    scanError,
    selectedRoots,
    pythonScopeId
  }
}
