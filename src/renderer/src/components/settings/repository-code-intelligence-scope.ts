import type { CodeIntelligenceCandidate } from '../../lib/language-server/code-intelligence-scope-discovery'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function getRepositoryCodeIntelligenceWorkspaceKey(
  repoId: string,
  isFolder: boolean
): CodeIntelligenceScope['workspaceKey'] {
  return isFolder ? `folder:${repoId}` : `worktree:${repoId}`
}

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
  const workspaceKey = getRepositoryCodeIntelligenceWorkspaceKey(args.repoId, args.isFolder)
  return {
    id: `${encodeURIComponent(args.executionHostId)}:${workspaceKey}:${args.language}`,
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

export function addCandidateToCodeIntelligenceScope(
  scope: CodeIntelligenceScope,
  candidate: CodeIntelligenceCandidate
): CodeIntelligenceScope {
  if (!candidate.languages.includes(scope.language)) {
    return scope
  }
  if (scope.members.some((member) => member.path === candidate.relativeRoot)) {
    return scope
  }
  return {
    ...scope,
    members: [...scope.members, { path: candidate.relativeRoot, visibleResults: true }]
  }
}
