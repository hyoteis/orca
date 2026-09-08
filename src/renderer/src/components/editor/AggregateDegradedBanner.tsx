import React, { useState } from 'react'
import { Database, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  CPP_LANGUAGES,
  findCppCodeIntelligenceScope
} from '@/lib/language-server/cpp-code-intelligence-workspace'
import { useAggregateMappingHealth } from '@/lib/language-server/use-aggregate-mapping-health'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'

// Why degraded gets a banner (#137 spec §2 Step 4): the last-valid entries
// keep working, so the failure is silent otherwise — exactly when the user
// needs to know their database edits stopped landing. Warnings never banner.
export function AggregateDegradedBanner({
  file,
  language
}: {
  file: OpenFile
  /** Monaco language id of the editor surface — gates to C/C++ documents. */
  language: string
}): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const scopeId = CPP_LANGUAGES.has(language)
    ? (findCppCodeIntelligenceScope(
        {
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId: file.worktreeId
        },
        { repos, settings }
      )?.id ?? null)
    : null
  const health = useAggregateMappingHealth(scopeId)
  const degraded = health?.some((mapping) => mapping.state === 'degraded') ?? false
  const [dismissed, setDismissed] = useState(false)
  // Auto-clears during render (no effect, no stale frame): recovery resets
  // the dismissal so a later degradation can surface again.
  const [wasDegraded, setWasDegraded] = useState(degraded)
  if (degraded !== wasDegraded) {
    setWasDegraded(degraded)
    if (!degraded) {
      setDismissed(false)
    }
  }
  if (!degraded || dismissed) {
    return null
  }
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
      role="alert"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <Database className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {translate(
          'settings.codeIntelligence.mappingDegradedBanner',
          'A compile database is unreadable — its last-valid entries are still in use. Restore the file to re-merge automatically.'
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => setDismissed(true)}
      >
        {translate('settings.codeIntelligence.mappingDegradedDismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
