import React from 'react'
import { cn } from '@/lib/utils'
import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'

export const LANGUAGE_DISPLAY: Record<CodeIntelligenceLanguage, string> = {
  cpp: 'C++',
  python: 'Python'
}
const LANGUAGE_BADGE: Record<CodeIntelligenceLanguage, string> = { cpp: 'C++', python: 'Py' }

export function LanguageBadge({ language }: { language: CodeIntelligenceLanguage }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[15px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-semibold leading-none',
        language === 'cpp'
          ? 'border border-border bg-secondary text-secondary-foreground'
          : 'border border-dashed border-border text-muted-foreground'
      )}
    >
      {LANGUAGE_BADGE[language]}
    </span>
  )
}
