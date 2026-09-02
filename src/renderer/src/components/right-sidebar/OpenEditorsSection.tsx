import React, { useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { useAppStore } from '@/store'
import { ChevronDown, ChevronRight, Pin, PinOff, X } from 'lucide-react'
import type { OpenFile } from '@/store/slices/editor'
import type { Tab } from '../../../../shared/types'
import { basename } from '@/lib/path'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

export type OpenEditorsDragContext = {
  ids: string[]
  reorder: (orderedIds: string[]) => void
}

// ponytail: pure seam so the drag-end logic is testable without firing a real
// dnd-kit gesture in happy-dom (DndContext exposes no onDragEnd to the DOM).
export function reorderOpenEditorsOnDragEnd(event: DragEndEvent, ctx: OpenEditorsDragContext): void {
  const { active, over } = event
  if (!over || active.id === over.id) {
    return
  }
  const from = ctx.ids.indexOf(String(active.id))
  const to = ctx.ids.indexOf(String(over.id))
  if (from === -1 || to === -1) {
    return
  }
  const next = [...ctx.ids]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  ctx.reorder(next)
}

/** One row per path: prefer the active entry, then a pinned one, then edit mode. */
function pickPreferredOpenFile(
  entries: readonly OpenFile[],
  activeId: string | null,
  isPinned: (file: OpenFile) => boolean
): OpenFile {
  return (
    entries.find((f) => f.id === activeId) ??
    entries.find((f) => isPinned(f)) ??
    entries.find((f) => f.mode === 'edit') ??
    entries[0]
  )
}

type SortableOpenEditorRowProps = {
  file: OpenFile
  pinned: boolean
  active: boolean
  uncommitted: boolean
  onSelect: () => void
  onClose: () => void
  onTogglePin: (pinned: boolean) => void
}

function SortableOpenEditorRow({
  file,
  pinned,
  active,
  uncommitted,
  onSelect,
  onClose,
  onTogglePin
}: SortableOpenEditorRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id
  })
  const fileName = basename(file.relativePath)
  // Why: applying the sortable transform animates siblings sliding away while
  // dragging, so the drop position is visible before release.
  const dragStyle: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={dragStyle}
          data-open-editor-row=""
          data-pinned={pinned ? 'true' : 'false'}
          {...attributes}
          {...listeners}
          onClick={onSelect}
          className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent ${
            active || isDragging ? 'bg-accent' : ''
          } ${isDragging ? 'z-10 shadow-md' : ''}`}
        >
          {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate">
                {fileName}
                {uncommitted ? <span className="text-muted-foreground"> (diff)</span> : null}
              </span>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6} className="max-w-80 break-all">
              {file.relativePath}
            </TooltipContent>
          </Tooltip>
          {file.isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
          <button
            type="button"
            aria-label={translate(
              'auto.components.right.sidebar.OpenEditorsSection.closeEditor',
              'Close editor'
            )}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            // Why: stop the drag listener on the row from activating on a close click.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onTogglePin(pinned)}>
          {pinned ? <PinOff /> : <Pin />}
          {translate(
            pinned
              ? 'auto.components.right.sidebar.OpenEditorsSection.unpin'
              : 'auto.components.right.sidebar.OpenEditorsSection.pin',
            pinned ? 'Unpin' : 'Pin'
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}>
          <X />
          {translate('auto.components.right.sidebar.OpenEditorsSection.close', 'Close')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function OpenEditorsSection(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFiles = useAppStore((s) => s.openFiles)
  const gitStatusEntries = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusByWorktree[activeWorktreeId] : undefined
  )
  const closeFile = useAppStore((s) => s.closeFile)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const reorderFiles = useAppStore((s) => s.reorderFiles)
  const pinFile = useAppStore((s) => s.pinFile)
  const unpinTab = useAppStore((s) => s.unpinTab)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)
  const unifiedTabs = useAppStore((s) =>
    activeWorktreeId ? s.unifiedTabsByWorktree[activeWorktreeId] : undefined
  )
  const [collapsed, setCollapsed] = useState(false)
  // Why: hook must run before the early return.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const worktreeFiles = openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  if (worktreeFiles.length === 0) {
    return null
  }
  const activeId = activeWorktreeId ? activeFileIdByWorktree?.[activeWorktreeId] : null
  const tabByEntity = new Map<string, Tab>()
  for (const tab of unifiedTabs ?? []) {
    if (!tabByEntity.has(tab.entityId)) {
      tabByEntity.set(tab.entityId, tab)
    }
  }
  const isPinned = (file: OpenFile): boolean => tabByEntity.get(file.id)?.isPinned === true

  // Why: one path can back several editors (edit + diff + preview); show one row
  // per path so the list reads as files, not sessions.
  const entriesByPath = new Map<string, OpenFile[]>()
  for (const file of worktreeFiles) {
    const list = entriesByPath.get(file.filePath)
    if (list) {
      list.push(file)
    } else {
      entriesByPath.set(file.filePath, [file])
    }
  }
  const rows = [...entriesByPath.values()].map((entries) =>
    pickPreferredOpenFile(entries, activeId, isPinned)
  )
  // Why: pinned rows float atop the list; the projected order is written back on
  // drop so the store keeps the invariant.
  const orderedRows = [
    ...rows.filter((file) => isPinned(file)),
    ...rows.filter((file) => !isPinned(file))
  ]
  const ids = orderedRows.map((f) => f.id)
  const closeAllOfPath = (file: OpenFile): void => {
    for (const candidate of worktreeFiles) {
      if (candidate.filePath === file.filePath) {
        closeFile(candidate.id)
      }
    }
  }
  const uncommittedPaths = new Set(
    (gitStatusEntries ?? []).map((entry) => entry.path.replaceAll('\\', '/'))
  )
  const isUncommitted = (file: OpenFile): boolean =>
    uncommittedPaths.has(file.relativePath.replaceAll('\\', '/')) ||
    file.diffSource === 'unstaged' ||
    file.diffSource === 'staged' ||
    file.diffSource === 'combined-uncommitted' ||
    (file.diffSource === 'combined-all' && (file.uncommittedEntriesSnapshot?.length ?? 0) > 0) ||
    file.mode === 'conflict-review'
  const handleDragEnd = (event: DragEndEvent): void =>
    reorderOpenEditorsOnDragEnd(event, { ids, reorder: reorderFiles })

  return (
    <div className="border-b border-border px-1 py-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={translate(
          'auto.components.right.sidebar.OpenEditorsSection.toggleSection',
          'Toggle Open Editors section'
        )}
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        )}
        {translate('auto.components.right.sidebar.OpenEditorsSection.title', 'Open Editors')}
        <span className="ml-auto tabular-nums">{ids.length}</span>
      </button>
      {/* ponytail: collapse state is session-local; thread it through persisted
          per-worktree UI settings if it must survive restarts. */}
      {!collapsed && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={ids}>
            {orderedRows.map((f) => {
              const tabId = tabByEntity.get(f.id)?.id ?? null
              return (
                <SortableOpenEditorRow
                  key={f.id}
                  file={f}
                  pinned={isPinned(f)}
                  active={f.id === activeId}
                  uncommitted={isUncommitted(f)}
                  onSelect={() => setActiveFile(f.id)}
                  onClose={() => closeAllOfPath(f)}
                  onTogglePin={(pinned) => {
                    if (!tabId) {
                      return
                    }
                    if (pinned) {
                      unpinTab(tabId)
                    } else {
                      pinFile(f.id, tabId)
                    }
                  }}
                />
              )
            })}
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
