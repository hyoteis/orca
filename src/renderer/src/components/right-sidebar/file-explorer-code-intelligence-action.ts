import type { TreeNode } from './file-explorer-types'

/** The right-clicked row plus its multi-selection, matching the drag payload rule. */
export function getCodeIntelligenceMenuTargetPaths(
  node: TreeNode,
  selectedPaths: ReadonlySet<string>
): string[] {
  return selectedPaths.has(node.path) && selectedPaths.size > 1 ? [...selectedPaths] : [node.path]
}
