import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/** Explorer's collapsible worktree section — hosts the file tree. */
export function WorktreeSection({
  collapsed,
  onToggleCollapsed,
  children
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Collapsed sheds flex-1 so the header hugs the section above; expanded
    // takes the remaining panel height.
    <div className={cn('flex min-h-0 flex-col', !collapsed && 'flex-1')}>
      <div className="border-y border-explorer-section-divider px-1 py-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={translate(
            'auto.components.right.sidebar.WorktreeSection.toggleSection',
            'Toggle files section'
          )}
          onClick={onToggleCollapsed}
          className="flex w-full items-center gap-1 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          {translate('auto.components.right.sidebar.WorktreeSection.title', 'Files')}
        </button>
      </div>
      {/* Why: hidden instead of unmounted so the virtualized tree keeps its scroll and cache. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'hidden')}>
        {children}
      </div>
    </div>
  )
}
