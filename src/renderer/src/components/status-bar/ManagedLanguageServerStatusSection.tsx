import { useMemo } from 'react'
import { Server } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { languageServerKindForScope } from '../../../../shared/code-intelligence-scope'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LanguageServerKind } from '../../../../shared/language-server-session'
import { ManagedLanguageServerToolSheet } from './ManagedLanguageServerToolSheet'

/** #21 C: the status sheet — Code results stay visible; managed-install
 * status lives in this on-demand secondary section inside the status popover. */
export function ManagedLanguageServerStatusSection({
  scopes,
  executionHostId
}: {
  scopes: readonly CodeIntelligenceScope[]
  executionHostId: ExecutionHostId | null
}): React.JSX.Element | null {
  const tools = useMemo(() => {
    const kinds: LanguageServerKind[] = []
    for (const scope of scopes) {
      const kind = languageServerKindForScope(scope.language)
      if (!kinds.includes(kind)) {
        kinds.push(kind)
      }
    }
    return kinds
  }, [scopes])
  if (tools.length === 0 || !executionHostId) {
    return null
  }
  return (
    <div className="border-b border-border/60 px-3 py-2">
      <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
        <Server className="size-3" />
        {translate(
          'settings.codeIntelligence.managedInstall.sectionTitle',
          'Managed language servers'
        )}
      </div>
      <div className="space-y-1">
        {tools.map((tool) => (
          <ManagedLanguageServerToolSheet
            key={tool}
            tool={tool}
            executionHostId={executionHostId}
            scopes={scopes}
          />
        ))}
      </div>
    </div>
  )
}
