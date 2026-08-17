import React from 'react'
import { useAppStore } from '@/store'
import { X } from 'lucide-react'

export function OpenEditorsSection(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)

  const files = openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  if (files.length === 0) {
    return null
  }
  const activeId = activeWorktreeId ? activeFileIdByWorktree?.[activeWorktreeId] : null

  return (
    <div className="border-b border-border px-1 py-1">
      <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Open Editors
      </div>
      {files.map((f) => (
        <div
          key={f.id}
          role="row"
          onClick={() => setActiveFile(f.id)}
          className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent ${
            f.id === activeId ? 'bg-accent' : ''
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{f.relativePath}</span>
          {f.isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
          <button
            type="button"
            aria-label="close"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              closeFile(f.id)
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
