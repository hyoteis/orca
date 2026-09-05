import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/** Explorer's collapsible worktree section — hosts the file tree / search body. */
export function WorktreeSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-1 py-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={translate(
            'auto.components.right.sidebar.WorktreeSection.toggleSection',
            'Toggle worktree section'
          )}
          onClick={() => setCollapsed((value) => !value)}
          className="flex w-full items-center gap-1 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          {translate('auto.components.right.sidebar.WorktreeSection.title', 'Worktree')}
        </button>
      </div>
      {/* Why: hidden instead of unmounted so the virtualized tree keeps its scroll and cache. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'hidden')}>
        {children}
      </div>
    </div>
  )
}
