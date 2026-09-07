import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'
import {
  findCodeIntelligenceRepo,
  findCodeIntelligenceScope
} from '@/lib/language-server/code-intelligence-workspace'
import { getPythonDocumentSymbols } from '@/lib/language-server/python-definition-navigation'
import { getCppDocumentSymbols } from '@/lib/language-server/cpp-definition-navigation'
import {
  semanticDocumentEditorFor,
  subscribeSemanticDocuments
} from '@/lib/language-server/semantic-monaco-documents'
import {
  outlineLanguageFamily,
  outlineRowsFromDocumentSymbols,
  resolveOutlineAutoScope,
  resolveOutlineTier,
  type OutlineSymbolRow
} from './outline-model'
import { extractHeuristicOutlineRows } from './outline-heuristics'
import { revealOutlineRow } from './outline-row-reveal'

export type OutlineSymbolsState =
  | { status: 'no-file' }
  | { status: 'unsupported' }
  | { status: 'unavailable'; reason: 'no-scope' | 'consent'; heuristicRows?: OutlineSymbolRow[] }
  | { status: 'loading' }
  | { status: 'enable'; repoId: string; language: CodeIntelligenceLanguage; heuristicRows?: OutlineSymbolRow[] }
  | { status: 'error'; message?: string; heuristicRows?: OutlineSymbolRow[] }
  | { status: 'ready'; rows: OutlineSymbolRow[] }

/** Document-change → symbol re-query delay (#102). */
const OUTLINE_REFRESH_DEBOUNCE_MS = 500

// Session collapse memory (#102): survives tab switches in-memory, keyed by
// file path; never persists across app restarts (out of scope per #98).
const collapsedRowsByFile = new Map<string, Set<string>>()
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set()

/** Heuristic tier rows (ADR 0003 tier 3) from the live editor text; undefined
 * while the document is not mounted (no badge, plain status). */
function heuristicRowsFor(activeFile: OpenFile | null): OutlineSymbolRow[] | undefined {
  const document = activeFile && semanticDocumentEditorFor(activeFile.id)
  return document && activeFile
    ? extractHeuristicOutlineRows(document.model.getValue(), activeFile.language)
    : undefined
}

function useActiveEditFile(): OpenFile | null {
  // Returns an existing OpenFile reference (or null) so unrelated store writes
  // do not re-render the panel.
  return useAppStore((s) => {
    if (s.activeTabType !== 'editor' || !s.activeFileId) {
      return null
    }
    const file = s.openFiles.find((f) => f.id === s.activeFileId)
    return file?.mode === 'edit' ? file : null
  })
}

/** Outline data (#99): follows the active editor tab; queries only on the
 * semantic tier so unconsented scopes never launch a session. #102 adds
 * cursor-follow, session collapse memory, debounced edit refresh, and retry. */
export function useOutlineSymbols(): {
  state: OutlineSymbolsState
  fileName: string | null
  reveal: (row: OutlineSymbolRow) => void
  /** 0-based LSP line of the editor cursor; null when unknown. */
  cursorLine: number | null
  collapsedKeys: ReadonlySet<string>
  toggleCollapsed: (key: string) => void
  retry: () => void
} {
  const activeFile = useActiveEditFile()
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const activeLanguage = activeFile?.language ?? ''
  const family = outlineLanguageFamily(activeLanguage)
  // Why inline: a cheap path-prefix scan returning a settings-stable ref.
  const scope =
    activeFile && family
      ? findCodeIntelligenceScope(
          {
            filePath: activeFile.filePath,
            relativePath: activeFile.relativePath,
            worktreeId: activeFile.worktreeId
          },
          family,
          { repos, settings }
        )
      : null
  // Why memoized: tier identity must stay stable across renders for the effect deps.
  const tier = useMemo(
    () => resolveOutlineTier({ language: activeLanguage, scope }),
    [activeLanguage, scope]
  )
  // Auto default scope (#101) — decided only when no scope covers the file, so
  // consented workspaces never pay for the check.
  const autoDecision = useMemo(() => {
    if (tier.kind !== 'unavailable' || tier.reason !== 'no-scope' || !activeFile || !family) {
      return null
    }
    // Same repo resolution as findCodeIntelligenceScope — one shared predicate.
    const repo = activeFile
      ? findCodeIntelligenceRepo(
          { filePath: activeFile.filePath, worktreeId: activeFile.worktreeId },
          { repos }
        )
      : null
    return {
      repo,
      decision: resolveOutlineAutoScope({
        workspace: repo
          ? {
              repoId: repo.id,
              repoName: repo.displayName,
              repoPath: repo.path,
              isFolder: isFolderRepo(repo)
            }
          : null,
        executionHostId: repo ? getRepoExecutionHostId(repo) : null,
        language: family,
        scopeName: translate(
          'auto.components.right.sidebar.use.outline.symbols.640345dd02',
          '{{value0}} {{value1}} — Outline default',
          {
            value0: repo?.displayName ?? '',
            value1: family === 'python' ? 'Python' : 'C++'
          }
        ),
        scopes: settings?.codeIntelligenceScopes ?? [],
        declinedAutoScopeIds: settings?.codeIntelligenceDeclinedAutoScopes ?? []
      })
    }
  }, [tier, activeFile, family, repos, settings])
  const [state, setState] = useState<OutlineSymbolsState>({ status: 'no-file' })
  const generationRef = useRef(0)
  const lastFileRef = useRef<string | null>(null)
  // #102: live refresh + retry + cursor-follow + collapse memory.
  const [contentTick, setContentTick] = useState(0)
  const [retryTick, setRetryTick] = useState(0)
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  const refreshTimerRef = useRef<number | undefined>(undefined)
  const filePath = activeFile?.filePath ?? null
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(EMPTY_COLLAPSED)
  // One auto-create attempt per id per mount: a failed upsert surfaces as the
  // plain no-scope state instead of a retry loop.
  const autoAttemptedRef = useRef(new Set<string>())
  // Why subscribe: the editor model registers a frame after this panel mounts.
  const [documentsTick, setDocumentsTick] = useState(0)
  useEffect(() => subscribeSemanticDocuments(() => setDocumentsTick((tick) => tick + 1)), [])

  useEffect(() => {
    if (autoDecision?.decision.kind !== 'create') {
      return
    }
    const scope = autoDecision.decision.scope
    if (autoAttemptedRef.current.has(scope.id)) {
      return
    }
    autoAttemptedRef.current.add(scope.id)
    void (async () => {
      try {
        const saved = await window.api.codeIntelligence.upsertScope(scope)
        // Same first-install pattern as the setup dialog: the flow that saves
        // the scope grants its consent — zero-config means no extra prompt.
        await window.api.codeIntelligence.grantConsent({
          scopeId: saved.id,
          revision: saved.revision
        })
        await useAppStore.getState().fetchSettings()
      } catch {
        // Attempt stays consumed: a failed create shows the no-scope state, no retry loop.
        setState({
          status: 'unavailable',
          reason: 'no-scope',
          heuristicRows: heuristicRowsFor(activeFile)
        })
      }
    })()
  }, [activeFile, autoDecision])

  useEffect(() => {
    // #103: cursor-follow + debounced refresh serve heuristic rows too.
    if (!activeFile || !family) {
      setCursorLine(null)
      return
    }
    const document = semanticDocumentEditorFor(activeFile.id)
    if (!document) {
      setCursorLine(null)
      return
    }
    const position = document.editor.getPosition?.()
    setCursorLine(position ? position.lineNumber - 1 : null)
    const cursorSub = document.editor.onDidChangeCursorPosition((event) =>
      setCursorLine(event.position.lineNumber - 1)
    )
    const contentSub = document.model.onDidChangeContent(() => {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => {
        setContentTick((tick) => tick + 1)
      }, OUTLINE_REFRESH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(refreshTimerRef.current)
      cursorSub.dispose()
      contentSub.dispose()
    }
  }, [activeFile, family, documentsTick])

  useEffect(() => {
    setCollapsedKeys(
      filePath ? (collapsedRowsByFile.get(filePath) ?? EMPTY_COLLAPSED) : EMPTY_COLLAPSED
    )
  }, [filePath])

  const toggleCollapsed = useCallback(
    (key: string) => {
      if (!filePath) {
        return
      }
      setCollapsedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        collapsedRowsByFile.set(filePath, next)
        return next
      })
    },
    [filePath]
  )

  const retry = useCallback(() => setRetryTick((tick) => tick + 1), [])

  useEffect(() => {
    if (!activeFile) {
      setState({ status: 'no-file' })
      return
    }
    if (tier.kind === 'unsupported') {
      setState({ status: 'unsupported' })
      return
    }
    if (tier.kind === 'unavailable') {
      if (tier.reason === 'no-scope' && autoDecision) {
        const { decision, repo } = autoDecision
        if ((decision.kind === 'declined' || decision.kind === 'remote-host') && repo) {
          // #98 story 10/11: heuristic symbols plus the explicit enable action.
          // autoDecision non-null implies family non-null (#106 preselect).
          setState({
            status: 'enable',
            repoId: repo.id,
            language: family ?? 'cpp',
            heuristicRows: heuristicRowsFor(activeFile)
          })
          return
        }
        if (decision.kind === 'create') {
          // Scope creation is in flight; symbols follow once its session warms.
          setState({ status: 'loading' })
          return
        }
      }
      setState({
        status: 'unavailable',
        reason: tier.reason,
        heuristicRows: heuristicRowsFor(activeFile)
      })
      return
    }
    // Why semanticDocumentEditorFor: the live Monaco text, not a disk re-read.
    const document = semanticDocumentEditorFor(activeFile.id)
    if (!document) {
      setState({ status: 'loading' })
      return
    }
    const generation = ++generationRef.current
    // Why functional: a same-file re-query (edit refresh, retry) keeps the
    // stale tree on screen instead of flashing the loading state (#102).
    const fileSwitched = lastFileRef.current !== activeFile.id
    lastFileRef.current = activeFile.id
    setState((prev) => (prev.status === 'ready' && !fileSwitched ? prev : { status: 'loading' }))
    // Why no text-deps: the debounced edit re-query lands via contentTick; the
    // version here only keys the shared navigation cache.
    const querySymbols = family === 'cpp' ? getCppDocumentSymbols : getPythonDocumentSymbols
    void querySymbols({
      fileId: activeFile.id,
      filePath: activeFile.filePath,
      relativePath: activeFile.relativePath,
      worktreeId: activeFile.worktreeId,
      language: activeFile.language,
      text: document.model.getValue(),
      documentVersion: document.model.getVersionId(),
      lineNumber: 1,
      column: 1
    })
      .then((symbols) => {
        if (generationRef.current !== generation) {
          return
        }
        if (symbols === null) {
          // Resolved null = the session dropped mid-query (clangd restart, scope
          // reset) — treat like a rejection, not an empty file (#107).
          setState({ status: 'error', heuristicRows: heuristicRowsFor(activeFile) })
          return
        }
        setState({ status: 'ready', rows: outlineRowsFromDocumentSymbols(symbols) })
      })
      .catch((error) => {
        // #103: a failed query keeps the user functional — heuristic rows ride
        // along with the honest error state and its retry (#102). The rejection
        // message is the only actionable signal (e.g. "Re-run C++ setup"), so
        // it rides along instead of the generic copy.
        if (generationRef.current === generation) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : undefined,
            heuristicRows: heuristicRowsFor(activeFile)
          })
        }
      })
  }, [activeFile, autoDecision, contentTick, documentsTick, family, retryTick, tier])

  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)

  const reveal = (row: OutlineSymbolRow): void =>
    revealOutlineRow(row, activeFile, scope, state.status === 'ready', setPendingEditorReveal)

  return {
    state,
    fileName: activeFile ? basename(activeFile.filePath) : null,
    reveal,
    cursorLine,
    collapsedKeys,
    toggleCollapsed,
    retry
  }
}
