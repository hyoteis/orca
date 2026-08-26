const directoryCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

function normalizeDirectoryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
}

function topLevelDirectory(path: string): string {
  const normalized = normalizeDirectoryPath(path)
  return normalized === '.' ? '' : (normalized.split('/')[0] ?? '')
}

function directoryDepth(path: string): number {
  const normalized = normalizeDirectoryPath(path)
  return normalized === '.' ? 0 : normalized.split('/').length
}

export function sortCodeIntelligenceDirectories(directories: readonly string[]): string[] {
  return [...directories].sort((left, right) => {
    const topLevelOrder = directoryCollator.compare(
      topLevelDirectory(left),
      topLevelDirectory(right)
    )
    if (topLevelOrder !== 0) {
      return topLevelOrder
    }
    const depthOrder = directoryDepth(left) - directoryDepth(right)
    return depthOrder || directoryCollator.compare(left, right)
  })
}

export function filterCodeIntelligenceDirectories(
  directories: readonly string[],
  query: string
): string[] {
  const normalizedQuery = normalizeDirectoryPath(query.trim()).toLocaleLowerCase()
  if (!query.trim()) {
    return [...directories]
  }
  return directories.filter((directory) =>
    normalizeDirectoryPath(directory).toLocaleLowerCase().includes(normalizedQuery)
  )
}

export function discoverCodeIntelligenceDirectories(relativeFiles: readonly string[]): string[] {
  const directories = new Set<string>(['.'])
  for (const file of relativeFiles) {
    const directoryEntry = /[\\/]$/.test(file)
    const segments = file.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)
    const directorySegmentCount = directoryEntry
      ? segments.length
      : Math.max(0, segments.length - 1)
    let path = ''
    for (let index = 0; index < directorySegmentCount; index += 1) {
      path = path ? `${path}/${segments[index]}` : segments[index]
      if (!path.split('/').includes('.git')) {
        directories.add(path)
      }
    }
  }
  return sortCodeIntelligenceDirectories([...directories])
}

export type CodeIntelligenceDirectoryTreeNode = {
  name: string
  path: string
  selectable: boolean
  children: CodeIntelligenceDirectoryTreeNode[]
}

export type CodeIntelligenceDirectoryTreeRow = CodeIntelligenceDirectoryTreeNode & {
  depth: number
}

function sortDirectoryTreeNodes(nodes: CodeIntelligenceDirectoryTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.path === '.') {
      return -1
    }
    if (right.path === '.') {
      return 1
    }
    return directoryCollator.compare(left.name, right.name)
  })
  nodes.forEach((node) => sortDirectoryTreeNodes(node.children))
}

export function buildCodeIntelligenceDirectoryTree(args: {
  directories: readonly string[]
  query: string
}): CodeIntelligenceDirectoryTreeNode[] {
  const matches = filterCodeIntelligenceDirectories(
    sortCodeIntelligenceDirectories(args.directories),
    args.query
  )
  const matchedPaths = new Set(matches.map(normalizeDirectoryPath))
  const roots: CodeIntelligenceDirectoryTreeNode[] = []
  const nodes = new Map<string, CodeIntelligenceDirectoryTreeNode>()

  for (const directory of matches) {
    const normalized = normalizeDirectoryPath(directory)
    if (normalized === '.') {
      const node = { name: '.', path: '.', selectable: true, children: [] }
      roots.push(node)
      nodes.set('.', node)
      continue
    }
    let parent: CodeIntelligenceDirectoryTreeNode | null = null
    let currentPath = ''
    for (const segment of normalized.split('/')) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let node = nodes.get(currentPath)
      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          selectable: matchedPaths.has(currentPath),
          children: []
        }
        nodes.set(currentPath, node)
        if (parent) {
          parent.children.push(node)
        } else {
          roots.push(node)
        }
      }
      parent = node
    }
  }
  sortDirectoryTreeNodes(roots)
  return roots
}

export function getDefaultCollapsedCodeIntelligenceDirectories(
  tree: readonly CodeIntelligenceDirectoryTreeNode[]
): Set<string> {
  const collapsed = new Set<string>()
  const visit = (nodes: readonly CodeIntelligenceDirectoryTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        collapsed.add(node.path)
      }
      visit(node.children, depth + 1)
    }
  }
  visit(tree, 0)
  return collapsed
}

export function flattenCodeIntelligenceDirectoryTree(args: {
  tree: readonly CodeIntelligenceDirectoryTreeNode[]
  collapsed: ReadonlySet<string>
  expandAll: boolean
}): CodeIntelligenceDirectoryTreeRow[] {
  const rows: CodeIntelligenceDirectoryTreeRow[] = []
  const visit = (nodes: readonly CodeIntelligenceDirectoryTreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ ...node, depth })
      if (args.expandAll || !args.collapsed.has(node.path)) {
        visit(node.children, depth + 1)
      }
    }
  }
  visit(args.tree, 0)
  return rows
}

function isDirectoryInside(path: string, parent: string): boolean {
  return parent === '.' || path === parent || path.startsWith(`${parent}/`)
}

function directoryAncestors(path: string): string[] {
  if (path === '.') {
    return []
  }
  const segments = path.split('/')
  const ancestors: string[] = ['.']
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'))
  }
  return ancestors
}

export type CodeIntelligenceDirectorySelectionState = boolean | 'indeterminate'

export function getCodeIntelligenceDirectorySelectionState(args: {
  directories: readonly string[]
  selected: ReadonlySet<string>
  path: string
}): CodeIntelligenceDirectorySelectionState {
  const subtree = args.directories.filter((directory) => isDirectoryInside(directory, args.path))
  const selectedCount = subtree.filter((directory) => args.selected.has(directory)).length
  if (selectedCount === 0) {
    return false
  }
  return selectedCount === subtree.length ? true : 'indeterminate'
}

export function toggleCodeIntelligenceDirectorySelection(args: {
  directories: readonly string[]
  selected: ReadonlySet<string>
  path: string
  checked: boolean
}): Set<string> {
  const next = new Set(args.selected)
  const subtree = args.directories.filter((directory) => isDirectoryInside(directory, args.path))
  if (args.checked) {
    subtree.forEach((directory) => next.add(directory))
    const ancestors = directoryAncestors(args.path).toReversed()
    for (const ancestor of ancestors) {
      const ancestorSubtree = args.directories.filter(
        (directory) => directory !== ancestor && isDirectoryInside(directory, ancestor)
      )
      if (ancestorSubtree.length > 0 && ancestorSubtree.every((directory) => next.has(directory))) {
        next.add(ancestor)
      }
    }
  } else {
    subtree.forEach((directory) => next.delete(directory))
    directoryAncestors(args.path).forEach((ancestor) => next.delete(ancestor))
  }
  return next
}

export function expandConfiguredCodeIntelligenceDirectories(
  directories: readonly string[],
  configured: readonly string[]
): Set<string> {
  const selected = new Set<string>()
  for (const configuredPath of configured) {
    directories
      .filter((directory) => isDirectoryInside(directory, configuredPath))
      .forEach((directory) => selected.add(directory))
  }
  return selected
}

export function getMinimalCodeIntelligenceDirectories(
  directories: readonly string[],
  selected: ReadonlySet<string>
): string[] {
  return sortCodeIntelligenceDirectories(
    directories.filter(
      (directory) =>
        selected.has(directory) &&
        !directoryAncestors(directory).some((ancestor) => selected.has(ancestor))
    )
  )
}
