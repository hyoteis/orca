import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { CodeIntelligenceCppSetupResult } from '../../../../shared/code-intelligence-cpp-setup'
import {
  getCodeIntelligenceScopeId,
  getCodeIntelligenceWorkspaceKey,
  getCppScopeIdForRepo,
  type CodeIntelligenceLanguage
} from '../../../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceCustomPaths,
  getMinimalCodeIntelligenceDirectories
} from './code-intelligence-directory-list'
import { useCodeIntelligenceDirectoryDiscovery } from './use-code-intelligence-directory-discovery'

export type SetupScopeSelectionMode = 'all' | 'selected'

/** Directory scan + language/folder selection state for the code-intelligence
 *  setup dialog — one hook so the dialog body stays under max-lines. */
export function useSetupScopeSelection({
  open,
  repo,
  initialLanguage
}: {
  open: boolean
  repo: Repo | null
  initialLanguage?: CodeIntelligenceLanguage
}): {
  mode: SetupScopeSelectionMode
  setMode: (mode: SetupScopeSelectionMode) => void
  language: CodeIntelligenceLanguage
  setLanguage: (language: CodeIntelligenceLanguage) => void
  roots: string[]
  selected: Set<string>
  setSelected: (selected: Set<string>) => void
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
  const [language, setLanguage] = useState<CodeIntelligenceLanguage>(initialLanguage ?? 'cpp')
  const [selected, setSelectedState] = useState<Set<string>>(new Set())
  const [directoryQuery, setDirectoryQuery] = useState('')
  const { roots, scanning, scanError, rescan, discoverWithin } =
    useCodeIntelligenceDirectoryDiscovery({ open, repo, settings })
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
    setLanguage(initialLanguage ?? 'cpp')
  }, [open, repo?.id, initialLanguage])

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    setMode('all')
    setDirectoryQuery('')
  }, [open, repo])

  useEffect(() => {
    if (!open || !repo) {
      return
    }
    // Why: tree rows map 1:1 to members — pre-check exactly what the language scope holds.
    const scopeId = language === 'cpp' ? getCppScopeIdForRepo(repo) : pythonScopeId
    const members =
      settingsRef.current?.codeIntelligenceScopes?.find((scope) => scope.id === scopeId)?.members ??
      []
    const paths = members.map((member) => member.path)
    setSelectedState(new Set(paths))
    discoverWithin(paths)
  }, [open, repo, language, pythonScopeId, discoverWithin])

  const setSelected = useCallback(
    (next: Set<string>): void => {
      setSelectedState(next)
      discoverWithin(next)
    },
    [discoverWithin]
  )
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
    () =>
      language === 'python' ? relativeSelectedRoots : [...relativeSelectedRoots, ...customRoots],
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
    rescan,
    scanning,
    scanError,
    selectedRoots,
    pythonScopeId
  }
}
