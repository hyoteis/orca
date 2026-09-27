import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab, TabContentType } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildPaletteTabDocument } from '@/lib/palette-match/tab-document'
import {
  buildSearchableBrowserPageDocument,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import {
  SIMULATOR_TYPE_SEARCH_ALIASES,
  simulatorPaletteTabTitle,
  type SearchableSimulatorTab
} from '@/lib/simulator-palette-search'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import {
  buildOpenTabsOverviewGroups,
  filterOpenTabsOverviewGroups,
  type OpenTabsOverviewInput
} from './open-tabs-overview-model'

const worktree: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/tmp/wt-1',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Aurora Workspace',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

const REPO_NAME = 'octo/rocket'
const WORKTREE_NAME = worktree.displayName
const BRANCH_NAME = 'main'

function makeTab<T extends TabContentType>(id: string, contentType: T): Tab & { contentType: T } {
  return {
    id,
    entityId: `${id}-entity`,
    groupId: 'group-1',
    worktreeId: worktree.id,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeWorkspaceTab({
  id,
  title,
  contentType = 'terminal',
  secondaryText = '',
  agentSnippets = [],
  occupantAgent = null,
  tabSortIndex = 0,
  isCurrentTab = false
}: {
  id: string
  title: string
  contentType?: 'terminal' | 'editor'
  secondaryText?: string
  agentSnippets?: string[]
  occupantAgent?: TuiAgent | null
  tabSortIndex?: number
  isCurrentTab?: boolean
}): SearchableWorkspaceTab {
  const secondarySearchTexts = secondaryText ? [secondaryText] : []
  return {
    tab: makeTab(id, contentType),
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex,
    title,
    secondaryText,
    titleSearchText: title,
    secondarySearchTexts,
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: secondarySearchTexts,
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME
    }),
    agentMetadata: agentSnippets.length
      ? [
          {
            paneKey: `${id}-pane`,
            textParts: [],
            snippetCandidates: agentSnippets,
            lastActivityAt: 0
          }
        ]
      : [],
    occupantAgent,
    isCurrentTab,
    isCurrentWorktree: true
  }
}

function makeBrowserPage(
  id: string,
  title: string,
  url = 'https://example.com',
  faviconUrl: string | null = null
): SearchableBrowserPage {
  const page: BrowserPage = {
    id,
    workspaceId: `${id}-ws`,
    worktreeId: worktree.id,
    url,
    title,
    loading: false,
    faviconUrl,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  const workspace: BrowserWorkspace = {
    id: `${id}-ws`,
    worktreeId: worktree.id,
    activePageId: id,
    pageIds: [id],
    url,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  return {
    page,
    workspace,
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    isCurrentPage: false,
    isCurrentWorktree: true,
    document: buildSearchableBrowserPageDocument({
      page,
      workspace,
      worktree,
      repoName: REPO_NAME
    })
  }
}

function makeSimulatorTab(id: string, label = 'iPhone 15'): SearchableSimulatorTab {
  const tab = { ...makeTab(id, 'simulator'), label }
  return {
    tab,
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    isCurrentTab: false,
    isCurrentWorktree: true,
    document: buildPaletteTabDocument({
      id: tab.id,
      title: simulatorPaletteTabTitle(tab),
      secondaryTexts: [],
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME,
      typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
    })
  }
}

function makeTerminalTab(id: string, launchAgent?: TuiAgent, shellOverride?: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: worktree.id,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent,
    shellOverride
  }
}

function build(
  workspaceTabs: SearchableWorkspaceTab[],
  terminalTabs: TerminalTab[] = [],
  browserPages: SearchableBrowserPage[] = [],
  simulatorTabs: SearchableSimulatorTab[] = []
): OpenTabsOverviewInput {
  return {
    workspaceTabs,
    browserPages,
    simulatorTabs,
    terminalTabsById: new Map(terminalTabs.map((tab) => [tab.id, tab]))
  }
}

describe('buildOpenTabsOverviewGroups', () => {
  it('splits workspace terminals into agent and shell groups, files into file', () => {
    const groups = buildOpenTabsOverviewGroups(
      build(
        [
          makeWorkspaceTab({ id: 't-shell', title: 'pnpm dev' }),
          makeWorkspaceTab({ id: 't-claude', title: 'claude · work' }),
          makeWorkspaceTab({ id: 'f-main', title: 'main.ts', contentType: 'editor' })
        ],
        [
          makeTerminalTab('t-shell-entity', undefined, 'pwsh.exe'),
          makeTerminalTab('t-claude-entity', 'claude')
        ]
      )
    )
    expect(groups.map((group) => group.kind)).toEqual(['agent', 'shell', 'file'])
    expect(groups[0].rows[0]).toMatchObject({
      key: 'workspace:t-claude',
      agent: 'claude',
      isCurrent: false,
      closeTarget: { type: 'unified', tabId: 't-claude' }
    })
    expect(groups[1].rows[0].key).toBe('workspace:t-shell')
    expect(groups[1].rows[0].agent).toBeNull()
    expect(groups[1].rows[0].shell).toBe('pwsh.exe')
    expect(groups[2].rows[0].activate).toMatchObject({
      source: 'workspace',
      contentType: 'editor',
      entityId: 'f-main-entity',
      relativePath: null
    })
  })

  it('groups a terminal by agent metadata when launchAgent is absent', () => {
    const groups = buildOpenTabsOverviewGroups(
      build([makeWorkspaceTab({ id: 't-manual', title: 'codex', agentSnippets: ['fix bug'] })], [])
    )
    expect(groups.map((group) => group.kind)).toEqual(['agent'])
    expect(groups[0].rows[0].agent).toBeNull()
  })

  it('orders groups agent→shell→file→browser→simulator and hides empty ones', () => {
    const groups = buildOpenTabsOverviewGroups(
      build(
        [
          makeWorkspaceTab({ id: 't-claude', title: 'claude' }),
          makeWorkspaceTab({ id: 't-shell', title: 'build' }),
          makeWorkspaceTab({ id: 'f-1', title: 'a.ts', contentType: 'editor' })
        ],
        [makeTerminalTab('t-claude-entity', 'claude')],
        [makeBrowserPage('p-1', 'GitHub')],
        [makeSimulatorTab('s-1')]
      )
    )
    expect(groups.map((group) => group.kind)).toEqual([
      'agent',
      'shell',
      'file',
      'browser',
      'simulator'
    ])
    expect(groups[3].rows[0]).toMatchObject({
      kind: 'browser',
      closeTarget: { type: 'browser-page', pageId: 'p-1' },
      activate: { source: 'browser', pageId: 'p-1', workspaceId: 'p-1-ws' }
    })
    expect(groups[4].rows[0].activate).toMatchObject({ source: 'simulator', tabId: 's-1' })
  })

  it('carries occupantAgent and the browser url/faviconUrl onto the activate payloads', () => {
    const groups = buildOpenTabsOverviewGroups(
      build(
        [makeWorkspaceTab({ id: 't-claude', title: 'claude', occupantAgent: 'claude' })],
        [makeTerminalTab('t-claude-entity', 'claude')],
        [
          makeBrowserPage(
            'p-1',
            'GitHub',
            'https://example.com/docs',
            'https://example.com/favicon.ico'
          )
        ]
      )
    )
    expect(groups[0].rows[0].activate).toMatchObject({
      source: 'workspace',
      tabId: 't-claude',
      occupantAgent: 'claude'
    })
    expect(groups[1].rows[0].activate).toMatchObject({
      source: 'browser',
      pageId: 'p-1',
      url: 'https://example.com/docs',
      faviconUrl: 'https://example.com/favicon.ico'
    })
  })

  it('sorts workspace rows by strip order and carries isCurrent', () => {
    const groups = buildOpenTabsOverviewGroups(
      build([
        makeWorkspaceTab({ id: 't-b', title: 'second', tabSortIndex: 1 }),
        makeWorkspaceTab({ id: 't-a', title: 'first', tabSortIndex: 0, isCurrentTab: true })
      ])
    )
    expect(groups[0].rows.map((row) => row.key)).toEqual(['workspace:t-a', 'workspace:t-b'])
    expect(groups[0].rows[0].isCurrent).toBe(true)
    expect(groups[0].rows[0].activate).toMatchObject({ tabId: 't-a' })
  })
})

describe('filterOpenTabsOverviewGroups', () => {
  const groups = buildOpenTabsOverviewGroups(
    build(
      [
        makeWorkspaceTab({ id: 't-claude', title: 'claude · drawer' }),
        makeWorkspaceTab({ id: 't-shell', title: 'pnpm dev' }),
        makeWorkspaceTab({
          id: 'f-main',
          title: 'main.ts',
          contentType: 'editor',
          secondaryText: 'src/app/main.tsx'
        })
      ],
      [makeTerminalTab('t-claude-entity', 'claude')]
    )
  )

  it('returns non-empty groups unchanged for a blank query', () => {
    expect(filterOpenTabsOverviewGroups(groups, '  ')).toEqual(groups)
  })

  it('matches titles and secondary text case-insensitively, dropping emptied groups', () => {
    const byTitle = filterOpenTabsOverviewGroups(groups, 'PNPM')
    expect(byTitle.map((group) => group.kind)).toEqual(['shell'])
    const byPath = filterOpenTabsOverviewGroups(groups, 'src/app')
    expect(byPath.map((group) => group.kind)).toEqual(['file'])
  })

  it('returns nothing when no row matches', () => {
    expect(filterOpenTabsOverviewGroups(groups, 'zzz')).toEqual([])
  })
})
