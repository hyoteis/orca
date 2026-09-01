import React from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isCodeIntelligenceConsentStale } from '../../../../shared/code-intelligence-scope'
import {
  CPP_LANGUAGES,
  findCppCodeIntelligenceScope
} from '@/lib/language-server/cpp-code-intelligence-workspace'
import type { OpenFile } from '@/store/slices/editor'

// Why: stale consent keeps authorizeSession throwing, so clangd never starts
// and C++ files read as unstyled white text (#62). This banner puts the
// recovery action where the symptom shows instead of the 33px status-bar icon.

export function CodeIntelligenceConsentBanner({
  file,
  language
}: {
  file: OpenFile
  /** Monaco language id of the editor surface — gates to C/C++ documents. */
  language: string
}): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const scope = CPP_LANGUAGES.has(language)
    ? findCppCodeIntelligenceScope(
        {
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId: file.worktreeId
        },
        { repos, settings }
      )
    : null
  if (!scope || !isCodeIntelligenceConsentStale(scope)) {
    return null
  }
  const handleReauthorize = async (): Promise<void> => {
    try {
      // Same grant entry the status-bar popover uses — no separate trust path.
      await window.api.codeIntelligence.grantConsent({
        scopeId: scope.id,
        revision: scope.revision
      })
    } catch (error) {
      toast.error(
        extractIpcErrorMessage(
          error,
          translate(
            'settings.codeIntelligence.reauthorizeFailed',
            'Could not reauthorize code intelligence folders'
          )
        )
      )
    }
    await fetchSettings()
  }
  return (
    // Why: role=alert — the state appears when a scope edit lands mid-session,
    // and screen readers must announce why coloring stopped unprompted.
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 font-medium text-foreground">
            {translate(
              'settings.codeIntelligence.editorConsentPaused',
              'Code intelligence paused — configuration changed since authorization'
            )}
          </span>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={() => void handleReauthorize()}
        >
          <ShieldCheck className="size-3.5" />
          {translate('settings.codeIntelligence.reauthorize', 'Reauthorize')}
        </Button>
      </div>
    </div>
  )
}
