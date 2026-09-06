import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  findCodeIntelligenceRepo,
  findCodeIntelligenceScope,
  openDefinitionTargetInWorkspace
} from '@/lib/language-server/code-intelligence-workspace'
import { getPythonDocumentSymbols } from '@/lib/language-server/python-definition-navigation'
import { getCppDocumentSymbols } from '@/lib/language-server/cpp-definition-navigation'
import { toServerFileUri } from '@/lib/language-server/language-server-document-uri'
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

export type OutlineSymbolsState =
  | { status: 'no-file' }
  | { status: 'unsupported' }
  | { status: 'unavailable'; reason: 'no-scope' | 'consent' }
  | { status: 'loading' }
  | { status: 'enable'; repoId: string }
  | { status: 'ready'; rows: OutlineSymbolRow[] }

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
 * semantic tier so unconsented scopes never launch a session. */
export function useOutlineSymbols(): {
  state: OutlineSymbolsState
  fileName: string | null
  reveal: (row: OutlineSymbolRow) => void
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
        setState({ status: 'unavailable', reason: 'no-scope' })
      }
    })()
  }, [autoDecision])

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
          setState({ status: 'enable', repoId: repo.id })
          return
        }
        if (decision.kind === 'create') {
          // Scope creation is in flight; symbols follow once its session warms.
          setState({ status: 'loading' })
          return
        }
      }
      setState({ status: 'unavailable', reason: tier.reason })
      return
    }
    // Why semanticDocumentEditorFor: the live Monaco text, not a disk re-read.
    const document = semanticDocumentEditorFor(activeFile.id)
    if (!document) {
      setState({ status: 'loading' })
      return
    }
    const generation = ++generationRef.current
    setState({ status: 'loading' })
    // Why no text-deps: #102 adds the debounced edit re-query; the version here
    // only keys the shared navigation cache.
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
        setState({ status: 'ready', rows: outlineRowsFromDocumentSymbols(symbols) })
      })
      .catch(() => {
        // Why empty, not error: the dedicated error+retry state lands with the
        // empty-state ticket; emptiness is the honest degraded view meanwhile.
        if (generationRef.current === generation) {
          setState({ status: 'ready', rows: [] })
        }
      })
  }, [activeFile, autoDecision, documentsTick, family, tier])

  const reveal = (row: OutlineSymbolRow): void => {
    if (!activeFile || !scope) {
      return
    }
    // Why this path: the shared symbol-open reveal reuses the open tab (#98).
    openDefinitionTargetInWorkspace(
      {
        filePath: activeFile.filePath,
        relativePath: activeFile.relativePath,
        worktreeId: activeFile.worktreeId
      },
      { uri: toServerFileUri(activeFile.filePath), range: row.range },
      scope
    )
  }

  return {
    state,
    fileName: activeFile ? basename(activeFile.filePath) : null,
    reveal
  }
}
