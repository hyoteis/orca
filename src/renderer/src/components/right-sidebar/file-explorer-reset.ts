export function getVisibleFileExplorerWorktreePath({
  rightSidebarOpen,
  worktreePath
}: {
  rightSidebarOpen: boolean
  worktreePath: string | null
}): string | null {
  // Why: the tree is the explorer's permanent body (variant C); a closed
  // sidebar must not trigger passive file loads or macOS app-data probes.
  return rightSidebarOpen ? worktreePath : null
}

export function shouldResetFileExplorerForVisibleWorktree(
  lastResetWorktreePath: string | null,
  visibleWorktreePath: string | null
): visibleWorktreePath is string {
  return visibleWorktreePath !== null && lastResetWorktreePath !== visibleWorktreePath
}
