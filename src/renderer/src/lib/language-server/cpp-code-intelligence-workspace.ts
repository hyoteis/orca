import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { isDocumentInCodeIntelligenceScope } from './code-intelligence-scope-membership'
import type { CppDefinitionTarget } from './cpp-definition-locations'

type CppWorkspaceRequest = {
  filePath: string
  relativePath: string
  worktreeId: string
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathStartsWith(path: string, root: string): boolean {
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

export function findCppCodeIntelligenceScope(
  request: CppWorkspaceRequest
): CodeIntelligenceScope | null {
  const state = useAppStore.getState()
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
        scope.language === 'cpp' &&
        scope.enabled &&
        scope.executionHostId === executionHostId &&
        pathStartsWith(request.filePath, scope.workspaceRoot) &&
        isDocumentInCodeIntelligenceScope(scope, request.relativePath)
    ) ?? null
  )
}

export function openCppDefinitionTargetInWorkspace(
  request: CppWorkspaceRequest,
  target: CppDefinitionTarget
): boolean {
  const scope = findCppCodeIntelligenceScope(request)
  if (!scope) {
    return false
  }
  const filePath = fileUriToHostPath(target.uri, scope.executionHostId)
  const relativePath = filePath ? relativeToRoot(filePath, scope.workspaceRoot) : null
  if (!filePath || relativePath === null) {
    return false
  }
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
