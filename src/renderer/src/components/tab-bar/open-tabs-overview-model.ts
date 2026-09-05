// Groups a worktree's open tabs (agent / shell / file / browser / simulator)
// into rows for the tab-bar overview dropdown. Pure: no store, no React.

import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { TerminalTab, TuiAgent } from '../../../../shared/types'
import type { OpenTabSearchResult } from './open-tab-search'
import type { OpenTabSearchEntries } from './open-tab-search-entries'

export type OpenTabsOverviewKind = 'agent' | 'shell' | 'file' | 'browser' | 'simulator'

export type OpenTabsOverviewCloseTarget =
  | { type: 'unified'; tabId: string }
  | { type: 'browser-page'; pageId: string }

export type OpenTabsOverviewRow = {
  key: string
  kind: OpenTabsOverviewKind
  title: string
  secondaryText: string
  isCurrent: boolean
  /** Provider glyph for agent rows; null everywhere else. */
  agent: TuiAgent | null
  /** ShellOverride stamped at create time; drives the shell brand icon. */
  shell: string | null
  activate: OpenTabSearchResult
  closeTarget: OpenTabsOverviewCloseTarget
}

export type OpenTabsOverviewGroup = {
  kind: OpenTabsOverviewKind
  rows: OpenTabsOverviewRow[]
}

export type OpenTabsOverviewInput = OpenTabSearchEntries & {
  /** Terminal records keyed by entity id, to read launchAgent off the tab. */
  terminalTabsById: ReadonlyMap<string, TerminalTab>
}

// Fixed section order in the dropdown: agents first (they need attention),
// then shells, files, and the web surfaces last.
const KIND_ORDER: readonly OpenTabsOverviewKind[] = ['agent', 'shell', 'file', 'browser', 'simulator']

function workspaceRow(
  entry: SearchableWorkspaceTab,
  terminalTab: TerminalTab | undefined
): OpenTabsOverviewRow {
  const tab = entry.tab
  // Why launchAgent OR metadata: launchAgent covers a freshly-launched idle
  // agent (no live status yet); metadata covers manually-started or sleeping
  // sessions whose tab record has no launch field.
  const agent = terminalTab?.launchAgent ?? null
  const isAgent = agent != null || entry.agentMetadata.length > 0
  return {
    key: `workspace:${tab.id}`,
    kind: isAgent ? 'agent' : tab.contentType === 'terminal' ? 'shell' : 'file',
    title: entry.title,
    secondaryText: entry.secondaryText,
    isCurrent: entry.isCurrentTab,
    agent,
    shell: terminalTab?.shellOverride ?? null,
    activate: {
      source: 'workspace',
      executionHostId: entry.worktree.hostId ?? LOCAL_EXECUTION_HOST_ID,
      id: `open-tab:workspace:${tab.id}`,
      title: entry.title,
      matchedText: null,
      worktreeId: entry.worktree.id,
      contentType: tab.contentType,
      tabId: tab.id,
      entityId: tab.entityId,
      groupId: tab.groupId,
      relativePath: tab.contentType === 'editor' ? entry.secondaryText || null : null
    },
    closeTarget: { type: 'unified', tabId: tab.id }
  }
}

export function buildOpenTabsOverviewGroups({
  workspaceTabs,
  browserPages,
  simulatorTabs,
  terminalTabsById
}: OpenTabsOverviewInput): OpenTabsOverviewGroup[] {
  const workspace: OpenTabsOverviewRow[] = workspaceTabs
    .slice()
    .sort(
      (a, b) =>
        a.groupSortIndex - b.groupSortIndex ||
        a.tabSortIndex - b.tabSortIndex ||
        a.tab.id.localeCompare(b.tab.id)
    )
    .map((entry) => workspaceRow(entry, terminalTabsById.get(entry.tab.entityId)))
  const browser: OpenTabsOverviewRow[] = browserPages.map((entry) => ({
    key: `browser:${entry.page.id}`,
    kind: 'browser',
    title: entry.page.title ?? entry.page.url,
    secondaryText: '',
    isCurrent: entry.isCurrentPage,
    agent: null,
    shell: null,
    activate: {
      source: 'browser',
      executionHostId: entry.worktree.hostId ?? LOCAL_EXECUTION_HOST_ID,
      id: `open-tab:browser:${entry.page.id}`,
      title: entry.page.title ?? entry.page.url,
      matchedText: null,
      worktreeId: entry.worktree.id,
      contentType: 'browser',
      pageId: entry.page.id,
      workspaceId: entry.workspace.id
    },
    closeTarget: { type: 'browser-page', pageId: entry.page.id }
  }))
  const simulator: OpenTabsOverviewRow[] = simulatorTabs.map((entry) => ({
    key: `simulator:${entry.tab.id}`,
    kind: 'simulator',
    title: entry.tab.label || 'Mobile Emulator',
    secondaryText: '',
    isCurrent: entry.isCurrentTab,
    agent: null,
    shell: null,
    activate: {
      source: 'simulator',
      executionHostId: entry.worktree.hostId ?? LOCAL_EXECUTION_HOST_ID,
      id: `open-tab:simulator:${entry.tab.id}`,
      title: entry.tab.label || 'Mobile Emulator',
      matchedText: null,
      worktreeId: entry.worktree.id,
      contentType: 'simulator',
      tabId: entry.tab.id,
      groupId: entry.tab.groupId
    },
    closeTarget: { type: 'unified', tabId: entry.tab.id }
  }))

  const byKind = new Map<OpenTabsOverviewKind, OpenTabsOverviewRow[]>([
    ['agent', workspace.filter((row) => row.kind === 'agent')],
    ['shell', workspace.filter((row) => row.kind === 'shell')],
    ['file', workspace.filter((row) => row.kind === 'file')],
    ['browser', browser],
    ['simulator', simulator]
  ])
  return KIND_ORDER.map((kind) => ({ kind, rows: byKind.get(kind)! })).filter(
    (group) => group.rows.length > 0
  )
}

// Keeps empty groups out after a query narrows the list, mirroring the
// unfiltered view's empty-group suppression.
export function filterOpenTabsOverviewGroups(
  groups: readonly OpenTabsOverviewGroup[],
  query: string
): OpenTabsOverviewGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return groups.filter((group) => group.rows.length > 0)
  }
  const matches = (row: OpenTabsOverviewRow): boolean =>
    row.title.toLowerCase().includes(needle) ||
    row.secondaryText.toLowerCase().includes(needle)
  return groups
    .map((group) => ({ kind: group.kind, rows: group.rows.filter(matches) }))
    .filter((group) => group.rows.length > 0)
}
