import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import type { CodeIntelligenceCppSetupResult } from '../../../../shared/code-intelligence-cpp-setup'
import { readRuntimeDirectory } from '../../runtime/runtime-file-client'
import { getCachedCodeIntelligenceDirectories } from '../../lib/language-server/code-intelligence-directory-scan-cache'
import { discoverCodeIntelligenceDirectoryBatch } from './code-intelligence-directory-discovery'
import { sortCodeIntelligenceDirectories } from './code-intelligence-directory-list'

type Result = {
  roots: string[]
  scanning: boolean
  scanError: CodeIntelligenceCppSetupResult | null
  rescan: () => void
  discoverWithin: (directories: Iterable<string>) => void
}

export function useCodeIntelligenceDirectoryDiscovery(args: {
  open: boolean
  repo: Repo | null
  settings: GlobalSettings | null
}): Result {
  const settingsRef = useRef(args.settings)
  settingsRef.current = args.settings
  const [roots, setRoots] = useState<string[]>([])
  const [pendingCount, setPendingCount] = useState(args.open && args.repo ? 1 : 0)
  const [scanError, setScanError] = useState<CodeIntelligenceCppSetupResult | null>(null)
  const [scanGeneration, setScanGeneration] = useState(0)
  const sessionRef = useRef(0)
  const scannedStartsRef = useRef(new Set<string>())

  const runScans = useCallback(
    (requestedStarts: Iterable<string>, force = false): void => {
      const repo = args.repo
      if (!args.open || !repo) {
        return
      }
      const starts = [
        ...new Set(
          [...requestedStarts]
            .filter((path) => !isRuntimePathAbsolute(path))
            .map(normalizeStartDirectory)
            .filter((path) => force || !scannedStartsRef.current.has(path))
        )
      ]
      if (starts.length === 0) {
        return
      }
      starts.forEach((path) => scannedStartsRef.current.add(path))
      setScanError(null)
      const session = sessionRef.current
      const executionHostId = getRepoExecutionHostId(repo)
      const host = parseExecutionHostId(executionHostId)
      const context = {
        settings: { ...settingsRef.current, activeRuntimeEnvironmentId: null },
        worktreeId: repo.id,
        worktreePath: repo.path,
        connectionId: repo.connectionId ?? undefined,
        expectedExecutionHostId:
          host?.kind === 'local' || host?.kind === 'ssh' ? host.id : undefined
      }
      setPendingCount((count) => count + starts.length)
      void Promise.allSettled(
        starts.map((startDirectory) =>
          getCachedCodeIntelligenceDirectories({
            key: `${executionHostId}:${repo.id}:${repo.path}:${startDirectory}`,
            force,
            loadDirectories: () =>
              discoverCodeIntelligenceDirectoryBatch({
                workspaceRoot: repo.path,
                startDirectory,
                readDirectory: (directoryPath) => readRuntimeDirectory(context, directoryPath)
              })
          })
        )
      ).then((results) => {
        if (sessionRef.current !== session) {
          return
        }
        const discovered = results.flatMap((result, index) => {
          if (result.status === 'fulfilled') {
            return result.value
          }
          scannedStartsRef.current.delete(starts[index])
          return []
        })
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          setScanError(toScanError(failure.reason))
        }
        setRoots((current) =>
          sortCodeIntelligenceDirectories([...new Set([...current, ...discovered])])
        )
        setPendingCount((count) => Math.max(0, count - starts.length))
      })
    },
    [args.open, args.repo]
  )

  useEffect(() => {
    const session = ++sessionRef.current
    scannedStartsRef.current.clear()
    setRoots([])
    setScanError(null)
    setPendingCount(0)
    if (args.open && args.repo) {
      runScans(['.'], scanGeneration > 0)
    }
    return () => {
      if (sessionRef.current === session) {
        sessionRef.current += 1
      }
    }
  }, [args.open, args.repo, runScans, scanGeneration])

  const rescan = useCallback(() => setScanGeneration((generation) => generation + 1), [])
  const discoverWithin = useCallback(
    (directories: Iterable<string>) => runScans(directories),
    [runScans]
  )

  return {
    roots,
    scanning: pendingCount > 0,
    scanError,
    rescan,
    discoverWithin
  }
}

function toScanError(error: unknown): CodeIntelligenceCppSetupResult {
  return {
    ok: false,
    message: translate(
      'settings.codeIntelligence.buildScanFailed',
      'Could not scan C++ build folders'
    ),
    log: error instanceof Error ? (error.stack ?? error.message) : String(error),
    relativeRoots: [],
    installedTools: []
  }
}

function normalizeStartDirectory(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}
