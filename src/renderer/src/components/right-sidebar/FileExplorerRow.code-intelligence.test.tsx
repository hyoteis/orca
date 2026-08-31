// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { FileExplorerRow } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'

afterEach(cleanup)

const directory: TreeNode = {
  name: 'engine',
  path: '/repo/engine',
  relativePath: 'engine',
  isDirectory: true,
  depth: 0
}

const makeScope = (members: CodeIntelligenceScope['members']): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language: 'cpp',
  members,
  serverSource: { type: 'custom', executable: 'clangd', args: [] },
  enabled: true,
  revision: 1
})

function renderRow(
  scope: CodeIntelligenceScope | null,
  selectedPaths: ReadonlySet<string> = new Set(),
  node: TreeNode = directory
) {
  const onToggleCodeIntelligenceMembers = vi.fn()
  render(
    <FileExplorerRow
      node={node}
      isExpanded={false}
      isLoading={false}
      isSelected={false}
      isFlashing={false}
      selectedPaths={new Set(selectedPaths)}
      nodeStatus={null}
      statusColor={null}
      isIgnored={false}
      deleteShortcutLabel="Del"
      connectionId={null}
      canOpenInOrcaBrowser={false}
      canCollapseFolderSubtree
      targetDir={node.path}
      targetDepth={1}
      selectionSize={selectedPaths.size || 1}
      onClick={vi.fn()}
      onDoubleClick={vi.fn()}
      onViewFile={vi.fn()}
      onContextMenuSelect={vi.fn()}
      onCopyPaths={vi.fn()}
      onStartNew={vi.fn()}
      onStartRename={vi.fn()}
      onDuplicate={vi.fn()}
      onAddFolderAsProject={vi.fn()}
      canAddAsProject={false}
      codeIntelligenceScope={scope}
      onToggleCodeIntelligenceMembers={onToggleCodeIntelligenceMembers}
      onOpenInTerminal={vi.fn()}
      onRequestDelete={vi.fn()}
      onCollapseFolderSubtree={vi.fn()}
      onFindInFolder={vi.fn()}
      onMoveDrop={vi.fn()}
      onDragTargetChange={vi.fn()}
      onDragSourceChange={vi.fn()}
      onDragExpandDir={vi.fn()}
      onNativeDragTargetChange={vi.fn()}
      onNativeDragExpandDir={vi.fn()}
    />
  )
  fireEvent.contextMenu(screen.getByRole('button'))
  return { onToggleCodeIntelligenceMembers }
}

describe('FileExplorerRow code intelligence menu item', () => {
  it('offers Remove for an exact member and forwards the action', () => {
    const { onToggleCodeIntelligenceMembers } = renderRow(
      makeScope([{ path: 'engine', visibleResults: true }])
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Code Intelligence' }))

    expect(onToggleCodeIntelligenceMembers).toHaveBeenCalledWith(['/repo/engine'], 'remove')
  })

  it('offers a disabled ✓ item inside a member', () => {
    renderRow(makeScope([{ path: 'engine', visibleResults: true }]), new Set(), {
      ...directory,
      name: 'core',
      path: '/repo/engine/core',
      relativePath: 'engine/core',
      depth: 1
    })

    const item = screen.getByRole('menuitem', { name: /In Code Intelligence/ })
    expect(item.hasAttribute('data-disabled')).toBe(true)
    expect(screen.queryByRole('menuitem', { name: 'Add to Code Intelligence' })).toBeNull()
  })

  it('offers Add outside every member', () => {
    const { onToggleCodeIntelligenceMembers } = renderRow(
      makeScope([{ path: 'fx', visibleResults: true }])
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Code Intelligence' }))

    expect(onToggleCodeIntelligenceMembers).toHaveBeenCalledWith(['/repo/engine'], 'add')
  })

  it('applies the action to the whole multi-selection', () => {
    const { onToggleCodeIntelligenceMembers } = renderRow(
      makeScope([{ path: 'fx', visibleResults: true }]),
      new Set(['/repo/engine', '/repo/tools', '/repo/engine/core.cpp'])
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Code Intelligence' }))

    expect(onToggleCodeIntelligenceMembers).toHaveBeenCalledWith(
      ['/repo/engine', '/repo/tools', '/repo/engine/core.cpp'],
      'add'
    )
  })

  it('hides the item for files and unconfigured workspaces', () => {
    renderRow(makeScope([{ path: 'engine', visibleResults: true }]), new Set(), {
      ...directory,
      isDirectory: false
    })
    expect(screen.queryByRole('menuitem', { name: 'Add to Code Intelligence' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove from Code Intelligence' })).toBeNull()

    cleanup()
    renderRow(null)
    expect(screen.queryByRole('menuitem', { name: 'Add to Code Intelligence' })).toBeNull()
  })
})
