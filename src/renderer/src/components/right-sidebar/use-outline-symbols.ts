import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import type { LanguageServerDocumentSymbolResult } from '../../../../shared/language-server-navigation-types'
import { isNativeNavigationLanguage } from '@/components/editor/lsp-navigation/editor-model-language-server-owner'
import {
  semanticDocumentEditorFor,
  subscribeSemanticDocuments
} from '@/components/editor/semantic-monaco-documents'
import {
  useLanguageServerIndexingState,
  type LanguageServerIndexingEntry
} from './use-language-server-indexing-state'
import { outlineRowsFromDocumentSymbols, type OutlineSymbolRow } from './outline-model'
import { revealOutlineRow } from './outline-row-reveal'
import { heuristicRowsFor } from './outline-active-heuristic-rows'

// Single-faced machine (spec-b §0): the IPC result's ok/failure collapses into
// one `unready` state with Retry; no scope/consent/enable semantics exist here.
export type OutlineSymbolsState =
  | { status: 'no-file' }
  | { status: 'unsupported' }
  | { status: 'loading' }
  | { status: 'unready'; message?: string; heuristicRows?: OutlineSymbolRow[] }
  | { status: 'ready'; rows: OutlineSymbolRow[] }

/** Document-change → symbol re-query delay (#102). */
const OUTLINE_REFRESH_DEBOUNCE_MS = 500

// Session collapse memory (#102): survives tab switches in-memory, keyed by
// file path; never persists across app restarts.
const collapsedRowsByFile = new Map<string, Set<string>>()
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set()

// Bounded promise dedupe, main's documentSymbolCache ported onto the IPC seam.
const DOCUMENT_SYMBOL_CACHE_LIMIT = 32
const documentSymbolCache = new Map<string, Promise<LanguageServerDocumentSymbolResult>>()

/** #107: !ok (and rejected) results never cache — a dropped session must not
 * pose as the answer for the next caller, least of all as "empty file". */
function fetchDocumentSymbols(
  filePath: string,
  version: number
): Promise<LanguageServerDocumentSymbolResult> {
  const key = `${filePath}:${version}`
  const cached = documentSymbolCache.get(key)
  if (cached) {
    return cached
  }
  const request = window.api.languageServers.documentSymbol({ filePath }).then(
    (result) => {
      if (!result.ok && documentSymbolCache.get(key) === request) {
        documentSymbolCache.delete(key)
      }
      return result
    },
    (error: unknown) => {
      if (documentSymbolCache.get(key) === request) {
        documentSymbolCache.delete(key)
      }
      throw error
    }
  )
  documentSymbolCache.set(key, request)
  while (documentSymbolCache.size > DOCUMENT_SYMBOL_CACHE_LIMIT) {
    const oldest = documentSymbolCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    documentSymbolCache.delete(oldest)
  }
  return request
}

/** Reset for unit tests (module cache would otherwise leak across renders). */
export function resetOutlineDocumentSymbolCacheForTests(): void {
  documentSymbolCache.clear()
}

function useActiveEditFile(): OpenFile | null {
  // Returns an existing OpenFile reference (or null) so unrelated store writes
  // do not re-render the panel; per-worktree active file matches the sidebar
  // sibling convention (OpenEditorsSection).
  return useAppStore((s) => {
    if (!s.activeWorktreeId) {
      return null
    }
    const activeFileId = s.activeFileIdByWorktree[s.activeWorktreeId]
    if (!activeFileId) {
      return null
    }
    const file = s.openFiles.find((f) => f.id === activeFileId)
    return file?.mode === 'edit' ? file : null
  })
}

/** Outline data (#99): follows the active editor tab and queries the
 * language-server documentSymbol IPC. #102 adds cursor-follow, session
 * collapse memory, debounced edit refresh, and retry; #103 keeps heuristic
 * rows riding along with unready. */
export function useOutlineSymbols(): {
  state: OutlineSymbolsState
  fileName: string | null
  /** Index state of the answering session; null when none applies (#163). */
  indexing: LanguageServerIndexingEntry | null
  reveal: (row: OutlineSymbolRow) => void
  /** 0-based LSP line of the editor cursor; null when unknown. */
  cursorLine: number | null
  collapsedKeys: ReadonlySet<string>
  toggleCollapsed: (key: string) => void
  retry: () => void
} {
  const activeFile = useActiveEditFile()
  const supported = isNativeNavigationLanguage(activeFile?.language ?? '')
  const [state, setState] = useState<OutlineSymbolsState>({ status: 'no-file' })
  // Remembered from the last successful query — the indexing subscription
  // keys off it (#163); !ok answers carry none.
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const generationRef = useRef(0)
  const lastFileRef = useRef<string | null>(null)
  // #102: live refresh + retry + cursor-follow + collapse memory.
  const [contentTick, setContentTick] = useState(0)
  const [retryTick, setRetryTick] = useState(0)
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  const refreshTimerRef = useRef<number | undefined>(undefined)
  const filePath = activeFile?.filePath ?? null
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(EMPTY_COLLAPSED)
  // Why subscribe: the editor model registers a frame after this panel mounts.
  const [documentsTick, setDocumentsTick] = useState(0)
  useEffect(() => subscribeSemanticDocuments(() => setDocumentsTick((tick) => tick + 1)), [])

  useEffect(() => {
    // #103: cursor-follow + debounced refresh serve heuristic rows too.
    if (!activeFile || !supported) {
      setCursorLine(null)
      return
    }
    const document = semanticDocumentEditorFor(activeFile.filePath)
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
  }, [activeFile, supported, documentsTick])

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
    if (!supported) {
      setState({ status: 'unsupported' })
      return
    }
    // Why semanticDocumentEditorFor: the main-process session only answers for
    // documents an editor has synced; until it registers there is nothing to
    // query (documentsTick re-runs this once it lands).
    const document = semanticDocumentEditorFor(activeFile.filePath)
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
    // version here only keys the shared result cache.
    void fetchDocumentSymbols(activeFile.filePath, document.model.getVersionId?.() ?? 0)
      .then((result) => {
        if (generationRef.current !== generation) {
          return
        }
        if (!result.ok) {
          // #107: !ok+null = session dead / request failed — never an empty file.
          setSessionKey(null)
          setState({
            status: 'unready',
            message: result.error,
            heuristicRows: heuristicRowsFor(activeFile)
          })
          return
        }
        setSessionKey(result.sessionKey)
        setState({ status: 'ready', rows: outlineRowsFromDocumentSymbols(result.symbols) })
      })
      .catch((error: unknown) => {
        // #103: a failed query keeps the user functional — heuristic rows ride
        // along with the honest unready state and its retry. The rejection
        // message is the only actionable signal, so it rides along.
        if (generationRef.current === generation) {
          setSessionKey(null)
          setState({
            status: 'unready',
            message: error instanceof Error ? error.message : undefined,
            heuristicRows: heuristicRowsFor(activeFile)
          })
        }
      })
  }, [activeFile, contentTick, documentsTick, retryTick, supported])

  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)

  const reveal = (row: OutlineSymbolRow): void =>
    revealOutlineRow(row, activeFile, setPendingEditorReveal)

  // #163: clangd's index state for the answering session — explains empty
  // symbol results while the workspace index is still building.
  const indexing = useLanguageServerIndexingState(sessionKey)

  return {
    state,
    fileName: activeFile ? basename(activeFile.filePath) : null,
    indexing,
    reveal,
    cursorLine,
    collapsedKeys,
    toggleCollapsed,
    retry
  }
}
