/** Directory names the cpp setup dialog scan lists but never descends into —
 * they mirror IGNORED_DIRECTORIES in code-intelligence-compilation-database,
 * so they can hold no selectable member sources, yet dominate huge trees. */
export const CODE_INTELLIGENCE_SCAN_PRUNE_NAMES = new Set([
  'out',
  'build',
  'node_modules'
])
