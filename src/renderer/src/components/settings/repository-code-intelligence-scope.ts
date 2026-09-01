import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceScopeId,
  getCodeIntelligenceWorkspaceKey
} from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function createRepositoryCodeIntelligenceScope(args: {
  repoId: string
  repoName: string
  repoPath: string
  isFolder: boolean
  executionHostId: ExecutionHostId
  language: CodeIntelligenceLanguage
  relativeRoot?: string
}): CodeIntelligenceScope {
  const languageLabel = args.language === 'python' ? 'Python' : 'C++'
  const workspaceKey = getCodeIntelligenceWorkspaceKey(args.repoId, args.isFolder)
  return {
    id: getCodeIntelligenceScopeId({
      executionHostId: args.executionHostId,
      workspaceKey,
      language: args.language
    }),
    name: `${args.repoName} ${languageLabel}`,
    executionHostId: args.executionHostId,
    workspaceKey,
    workspaceRoot: args.repoPath,
    language: args.language,
    members: [{ path: args.relativeRoot ?? '.', visibleResults: true }],
    serverSource: { type: 'automatic' },
    enabled: true,
    revision: 0
  }
}
