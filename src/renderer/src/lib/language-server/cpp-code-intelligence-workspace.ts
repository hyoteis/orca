import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  findCodeIntelligenceScope,
  fileUriToHostPath,
  openDefinitionTargetInWorkspace,
  relativeToRoot,
  type CodeIntelligenceWorkspaceRequest,
  type DefinitionTarget
} from './code-intelligence-workspace'

export {
  fileUriToHostPath,
  relativeToRoot,
  pathStartsWith,
  visibleWorkspaceSymbols
} from './code-intelligence-workspace'
export type {
  CodeIntelligenceWorkspaceRequest,
  CodeIntelligenceDocumentRequest,
  WorkspaceSymbolFanout
} from './code-intelligence-workspace'

// Lives here (not in cpp-definition-navigation) so banner/UI code can gate on
// C/C++ without pulling the vscode-jsonrpc/browser import chain into tests.
export const CPP_LANGUAGES = new Set(['c', 'cpp', 'objective-c', 'objective-cpp'])

export function findCppCodeIntelligenceScope(
  request: CodeIntelligenceWorkspaceRequest,
  state?: Parameters<typeof findCodeIntelligenceScope>[2]
): CodeIntelligenceScope | null {
  return findCodeIntelligenceScope(request, 'cpp', state)
}

export function openCppDefinitionTargetInWorkspace(
  request: CodeIntelligenceWorkspaceRequest,
  target: DefinitionTarget
): boolean {
  const scope = findCppCodeIntelligenceScope(request)
  if (!scope) {
    return false
  }
  const filePath = fileUriToHostPath(target.uri, scope.executionHostId)
  // C++ definitions stay workspace-bound (headers outside the root keep today's behavior).
  if (!filePath || relativeToRoot(filePath, scope.workspaceRoot) === null) {
    return false
  }
  return openDefinitionTargetInWorkspace(request, target, scope)
}
