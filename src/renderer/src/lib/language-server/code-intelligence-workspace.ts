import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import {
  isCodeIntelligenceResultVisible,
  isDocumentInCodeIntelligenceScope
} from './code-intelligence-scope-membership'
import type { SymbolInformation, WorkspaceSymbol } from 'vscode-languageserver-protocol'

/** Language-neutral workspace-symbol fan-out shape shared by Python and C++. */
export type WorkspaceSymbolFanout = {
  results: {
    scopeId: string
    scopeName: string
    symbols: (SymbolInformation | WorkspaceSymbol)[]
  }[]
  /** True when at least one scope's request rejected (#13 partial labelling). */
  partial: boolean
}

/** Positive visible-result allow-list (#12): only members marked visible surface. */
export function visibleWorkspaceSymbols(
  scope: CodeIntelligenceScope,
  symbols: (SymbolInformation | WorkspaceSymbol)[]
): (SymbolInformation | WorkspaceSymbol)[] {
  return symbols.filter((symbol) => {
    const path = fileUriToHostPath(symbol.location.uri, scope.executionHostId)
    const relativePath = path ? relativeToRoot(path, scope.workspaceRoot) : null
    return relativePath !== null && isCodeIntelligenceResultVisible(scope, relativePath)
  })
}

export type CodeIntelligenceWorkspaceRequest = {
  filePath: string
  relativePath: string
  worktreeId: string
}

/** Shared editor-document request shape for both language provider stacks. */
export type CodeIntelligenceDocumentRequest = CodeIntelligenceWorkspaceRequest & {
  fileId: string
  language: string
  text: string
  documentVersion: number
  lineNumber: number
  column: number
}

export type DefinitionTarget = {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function pathStartsWith(path: string, root: string): boolean {
  const left = normalizePath(path)
  const right = normalizePath(root)
  if (/^[A-Za-z]:\//.test(left) || /^[A-Za-z]:\//.test(right)) {
    return (
      left.toLowerCase() === right.toLowerCase() ||
      left.toLowerCase().startsWith(`${right.toLowerCase()}/`)
    )
  }
  return left === right || left.startsWith(`${right}/`)
}

export function relativeToRoot(path: string, root: string): string | null {
  if (!pathStartsWith(path, root)) {
    return null
  }
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  return normalizedPath.length === normalizedRoot.length
    ? '.'
    : normalizedPath.slice(normalizedRoot.length + 1)
}

export function fileUriToHostPath(uri: string, executionHostId: string): string | null {
  const url = new URL(uri)
  if (url.protocol !== 'file:') {
    return null
  }
  const pathname = decodeURIComponent(url.pathname)
  if (url.hostname) {
    return `//${url.hostname}${pathname}`
  }
  if (executionHostId === 'local' && /^\/[A-Za-z]:\//.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\')
  }
  return pathname
}

export function findCodeIntelligenceScope(
  request: CodeIntelligenceWorkspaceRequest,
  language: CodeIntelligenceLanguage,
  // Subscription-fed override so React callers re-derive on settings/repos changes.
  state: Pick<ReturnType<typeof useAppStore.getState>, 'repos' | 'settings'> = useAppStore.getState()
): CodeIntelligenceScope | null {
  const repo = state.repos.find(
    (candidate) =>
      candidate.id === request.worktreeId || pathStartsWith(request.filePath, candidate.path)
  )
  if (!repo) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(repo)
  return (
    state.settings?.codeIntelligenceScopes?.find(
      (scope) =>
        scope.language === language &&
        scope.enabled &&
        scope.executionHostId === executionHostId &&
        pathStartsWith(request.filePath, scope.workspaceRoot) &&
        isDocumentInCodeIntelligenceScope(scope, request.relativePath)
    ) ?? null
  )
}

export function openDefinitionTargetInWorkspace(
  request: CodeIntelligenceWorkspaceRequest,
  target: DefinitionTarget,
  scope: CodeIntelligenceScope
): boolean {
  const filePath = fileUriToHostPath(target.uri, scope.executionHostId)
  if (!filePath) {
    return false
  }
  // External dependency targets (site-packages, system headers) keep their
  // absolute Host path as the tab label — they have no workspace-relative form.
  const relativePath = relativeToRoot(filePath, scope.workspaceRoot) ?? filePath
  const state = useAppStore.getState()
  state.setPendingEditorReveal(null)
  state.openFile(
    {
      filePath,
      relativePath,
      worktreeId: request.worktreeId,
      language: detectLanguage(relativePath),
      mode: 'edit'
    },
    {
      forceContentReload: true,
      focusEditor: true,
      suppressActiveRuntimeFallback: scope.executionHostId === 'local'
    }
  )
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      state.setPendingEditorReveal({
        filePath,
        line: target.range.start.line + 1,
        column: target.range.start.character + 1,
        matchLength: Math.max(0, target.range.end.character - target.range.start.character)
      })
    })
  })
  return true
}
