import { useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'
import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { listRuntimeFiles } from '../../runtime/runtime-file-client'
import {
  discoverCodeIntelligenceCandidates,
  type CodeIntelligenceCandidate
} from '../../lib/language-server/code-intelligence-scope-discovery'
import { Button } from '../ui/button'
import { CodeIntelligenceScopeEditor } from './CodeIntelligenceScopeEditor'
import {
  addCandidateToCodeIntelligenceScope,
  createRepositoryCodeIntelligenceScope,
  getRepositoryCodeIntelligenceWorkspaceKey
} from './repository-code-intelligence-scope'

type Props = { repo: Repo }

export function RepositoryCodeIntelligenceSection({ repo }: Props): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const [discovering, setDiscovering] = useState(false)
  const [candidates, setCandidates] = useState<CodeIntelligenceCandidate[]>([])
  const executionHostId = getRepoExecutionHostId(repo)
  const workspaceKey = getRepositoryCodeIntelligenceWorkspaceKey(repo.id, isFolderRepo(repo))
  const scopes = useMemo(
    () =>
      (settings?.codeIntelligenceScopes ?? []).filter(
        (scope) => scope.workspaceKey === workspaceKey && scope.executionHostId === executionHostId
      ),
    [executionHostId, settings?.codeIntelligenceScopes, workspaceKey]
  )

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    try {
      const host = parseExecutionHostId(executionHostId)
      const runtimeSettings =
        host?.kind === 'runtime'
          ? { ...settings, activeRuntimeEnvironmentId: host.environmentId }
          : { ...settings, activeRuntimeEnvironmentId: null }
      const files = await listRuntimeFiles(
        {
          settings: runtimeSettings,
          worktreeId: repo.id,
          worktreePath: repo.path,
          connectionId: repo.connectionId ?? undefined,
          expectedExecutionHostId:
            host?.kind === 'local' || host?.kind === 'ssh' ? host.id : undefined
        },
        { rootPath: repo.path }
      )
      setCandidates(discoverCodeIntelligenceCandidates(files))
    } catch (error) {
      toast.error(
        translate('settings.codeIntelligence.discoveryFailed', 'Could not scan project markers'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setDiscovering(false)
    }
  }

  const addScope = async (
    language: CodeIntelligenceLanguage,
    candidate?: CodeIntelligenceCandidate
  ): Promise<void> => {
    const existing = scopes.find((scope) => scope.language === language)
    const next = existing
      ? candidate
        ? addCandidateToCodeIntelligenceScope(existing, candidate)
        : existing
      : createRepositoryCodeIntelligenceScope({
          repoId: repo.id,
          repoName: repo.displayName,
          repoPath: repo.path,
          isFolder: isFolderRepo(repo),
          executionHostId,
          language,
          relativeRoot: candidate?.relativeRoot
        })
    await window.api.codeIntelligence.upsertScope(next)
    await fetchSettings()
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate('settings.codeIntelligence.title', 'Code Intelligence')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.codeIntelligence.description',
              'Configure Python and C++ semantic scopes on this Host. Orca does not modify project files.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={discovering}
          onClick={() => void discover()}
        >
          <RefreshCw className={discovering ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {discovering
            ? translate('settings.codeIntelligence.discovering', 'Scanning...')
            : translate('settings.codeIntelligence.discover', 'Discover scopes')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['python', 'cpp'] as const).map((language) => (
          <Button
            key={language}
            type="button"
            variant="outline"
            size="sm"
            disabled={scopes.some((scope) => scope.language === language)}
            onClick={() => void addScope(language)}
          >
            <Plus className="size-3.5" />
            {language === 'python'
              ? translate('settings.codeIntelligence.addPython', 'Add Python scope')
              : translate('settings.codeIntelligence.addCpp', 'Add C++ scope')}
          </Button>
        ))}
      </div>

      {candidates.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium">
            {translate('settings.codeIntelligence.candidates', 'Detected project roots')}
          </p>
          {candidates.map((candidate) => (
            <div
              key={candidate.relativeRoot}
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <span className="text-muted-foreground">
                {candidate.relativeRoot} ? {candidate.markers.join(', ')}
              </span>
              <div className="flex gap-2">
                {candidate.languages.map((language) => (
                  <Button
                    key={language}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void addScope(language, candidate)}
                  >
                    {language === 'python'
                      ? translate('settings.codeIntelligence.python', 'Python')
                      : translate('settings.codeIntelligence.cpp', 'C++')}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {scopes.map((scope) => (
        <CodeIntelligenceScopeEditor key={scope.id} scope={scope} onRefresh={fetchSettings} />
      ))}
    </section>
  )
}
