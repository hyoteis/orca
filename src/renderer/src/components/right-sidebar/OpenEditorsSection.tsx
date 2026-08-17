import React from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { useAppStore } from '@/store'
import { X } from 'lucide-react'
import type { OpenFile } from '@/store/slices/editor'

export type OpenEditorsDragContext = {
  worktreeId: string
  ids: string[]
  reorder: (worktreeId: string, fromIndex: number, toIndex: number) => void
}

// ponytail: pure seam so the drag-end logic is testable without firing a real
// dnd-kit gesture in jsdom (DndContext exposes no onDragEnd to the DOM).
export function reorderOpenFilesOnDragEnd(event: DragEndEvent, ctx: OpenEditorsDragContext): void {
  const { active, over } = event
  if (!over || active.id === over.id) {
    return
  }
  const from = ctx.ids.indexOf(String(active.id))
  const to = ctx.ids.indexOf(String(over.id))
  if (from === -1 || to === -1) {
    return
  }
  ctx.reorder(ctx.worktreeId, from, to)
}

type SortableOpenFileRowProps = {
  file: OpenFile
  active: boolean
  onSelect: () => void
  onClose: () => void
}

function SortableOpenFileRow({ file, active, onSelect, onClose }: SortableOpenFileRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useSortable({ id: file.id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent ${
        active ? 'bg-accent' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{file.relativePath}</span>
      {file.isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
      <button
        type="button"
        aria-label="close"
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
  )
}

export function OpenEditorsSection(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const reorderOpenFiles = useAppStore((s) => s.reorderOpenFiles)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)
  // Why: hook must run before the early return.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const files = openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  if (files.length === 0) {
    return null
  }
  const activeId = activeWorktreeId ? activeFileIdByWorktree?.[activeWorktreeId] : null
  const ids = files.map((f) => f.id)
  const handleDragEnd = (event: DragEndEvent): void =>
    reorderOpenFilesOnDragEnd(event, {
      worktreeId: activeWorktreeId as string,
      ids,
      reorder: reorderOpenFiles
    })

  return (
    <div className="border-b border-border px-1 py-1">
      <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Open Editors
      </div>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={ids}>
          {files.map((f) => (
            <SortableOpenFileRow
              key={f.id}
              file={f}
              active={f.id === activeId}
              onSelect={() => setActiveFile(f.id)}
              onClose={() => closeFile(f.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}
