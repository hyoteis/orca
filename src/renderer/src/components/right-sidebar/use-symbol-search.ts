import { useEffect, useMemo, useRef, useState } from 'react'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { searchPythonWorkspaceSymbols } from '@/lib/language-server/python-definition-navigation'
import { searchCppWorkspaceSymbols } from '@/lib/language-server/cpp-definition-navigation'
import { openDefinitionTargetInWorkspace } from '@/lib/language-server/code-intelligence-workspace'
import type { WorkspaceSymbolFanout } from '@/lib/language-server/code-intelligence-workspace'
import {
  buildSymbolSearchRows,
  type SymbolRow,
  type SymbolScopeInfo
} from './symbol-search-rows'

const SYMBOL_SEARCH_DEBOUNCE_MS = 250

type UseSymbolSearchArgs = {
  query: string
  symbolMode: boolean
  scopes: readonly CodeIntelligenceScope[]
}

/** Workspace-symbol Command center data (#32): debounced fan-out, transient results. */
export function useSymbolSearch({ query, symbolMode, scopes }: UseSymbolSearchArgs): {
  rows: SymbolRow[]
  loading: boolean
  /** True when at least one scope's fan-out rejected — show the Partial label. */
  partial: boolean
} {
  const [rows, setRows] = useState<SymbolRow[]>([])
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState(false)
  // Guards a slow first response from painting over a fresher one.
  const generationRef = useRef(0)
  const scopeInfoById = useMemo(
    () =>
      new Map<string, SymbolScopeInfo>(
        scopes.map((scope) => [
          scope.id,
          { workspaceRoot: scope.workspaceRoot, executionHostId: scope.executionHostId }
        ])
      ),
    [scopes]
  )

  useEffect(() => {
    const trimmed = query.trim()
    if (!symbolMode || !trimmed) {
      generationRef.current += 1
      // Returning prev keeps identity stable so a scopes-identity re-run with an
      // already-empty state does not re-render (and loop on unstable callers).
      setRows((prev) => (prev.length === 0 ? prev : []))
      setPartial(false)
      setLoading(false)
      return
    }
    const generation = ++generationRef.current
    setLoading(true)
    const timer = setTimeout(() => {
      // Both language stacks answer in parallel (#7: Python and C++).
      void Promise.all([
        searchPythonWorkspaceSymbols(trimmed),
        searchCppWorkspaceSymbols(trimmed)
      ]).then(([python, cpp]) => {
        if (generationRef.current !== generation) {
          return
        }
        const fanout: WorkspaceSymbolFanout = {
          results: [...python.results, ...cpp.results],
          partial: python.partial || cpp.partial
        }
        setRows(buildSymbolSearchRows(fanout, scopeInfoById))
        setPartial(fanout.partial)
        setLoading(false)
      })
    }, SYMBOL_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, symbolMode, scopeInfoById])

  return { rows, loading, partial }
}

/** Opens one symbol row via the shared definition-open path (reveal included). */
export function openSymbolSearchResult(
  row: SymbolRow,
  worktreeId: string,
  scopes: readonly CodeIntelligenceScope[]
): boolean {
  const scope = scopes.find((candidate) => candidate.id === row.scopeId)
  if (!scope || !row.range) {
    return false
  }
  return openDefinitionTargetInWorkspace(
    // filePath/relativePath are unused by the open path (it derives from the
    // target uri); only worktreeId routes the tab.
    { filePath: row.displayPath, relativePath: row.displayPath, worktreeId },
    { uri: row.uri, range: row.range },
    scope
  )
}
