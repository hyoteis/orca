// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitStatusEntry } from '../../../../shared/types'
import SourceControl from './SourceControl'

const mocks = vi.hoisted(() => {
  const activeRepo = {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
  const activeWorktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt',
    head: 'abcdef123',
    branch: 'refs/heads/feature/submodule-checkbox',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature/submodule-checkbox',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  return {
    activeRepo,
    activeWorktree,
    state: {} as Record<string, unknown>,
    getRuntimeGitSubmoduleStatus: vi.fn()
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) =>
      selector ? selector(mocks.state) : mocks.state,
    {
      getState: () => mocks.state
    }
  )
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mocks.activeWorktree,
  useRepoById: (repoId: string | null) =>
    repoId === mocks.activeRepo.id ? mocks.activeRepo : null,
  useWorktreeMap: () => new Map([[mocks.activeWorktree.id, mocks.activeWorktree]])
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: vi.fn().mockResolvedValue(undefined)
}))

// Why: the lazy submodule expansion fetch must be controllable so an expanded
// dirty submodule's inner child rows materialize synchronously in the test.
// Why: the lazy submodule expansion fetch must be controllable so an expanded
// dirty submodule's inner child rows materialize synchronously in the test.
vi.mock('@/runtime/runtime-git-client', async (importOriginal) => {
  const actual = await importOriginal<{ getRuntimeGitSubmoduleStatus: typeof mocks.getRuntimeGitSubmoduleStatus }>()
  return { ...actual, getRuntimeGitSubmoduleStatus: mocks.getRuntimeGitSubmoduleStatus }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

function gitEntry(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: 'src/file.ts',
    area: 'unstaged',
    status: 'modified',
    added: 1,
    removed: 0,
    ...overrides
  } as GitStatusEntry
}

function submoduleEntry(): GitStatusEntry {
  return gitEntry({
    path: 'sub',
    submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
  })
}

function noopAsync(value: unknown = undefined): () => Promise<unknown> {
  return vi.fn().mockResolvedValue(value)
}

function resetState(overrides: Partial<Record<string, unknown>> = {}): void {
  vi.clearAllMocks()
  mocks.state = {
    activeWorktreeId: mocks.activeWorktree.id,
    activeGroupIdByWorktree: { [mocks.activeWorktree.id]: 'group-1' },
    groupsByWorktree: { [mocks.activeWorktree.id]: [{ id: 'group-1', activeTabId: null }] },
    repos: [mocks.activeRepo],
    worktreesByRepo: { [mocks.activeRepo.id]: [mocks.activeWorktree] },
    rightSidebarOpen: false,
    rightSidebarTab: 'source-control',
    gitStatusByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchChangesByWorktree: { [mocks.activeWorktree.id]: [] },
    gitBranchCompareSummaryByWorktree: { [mocks.activeWorktree.id]: null },
    gitBranchLineTotalByWorktree: {},
    gitConflictOperationByWorktree: {},
    remoteStatusesByWorktree: {},
    isRemoteOperationActive: false,
    inFlightRemoteOpKind: null,
    settings: null,
    hostedReviewCache: {},
    prCache: {},
    commitMessageGenerationRecords: {},
    pullRequestGenerationRecords: {},
    openFiles: [],
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    getDiffComments: vi.fn(() => []),
    updateSettings: noopAsync(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    fetchHostedReviewForBranch: noopAsync(),
    getHostedReviewCreationEligibility: noopAsync(null),
    createHostedReview: noopAsync({ ok: false, error: 'not available' }),
    updateWorktreeMeta: noopAsync(),
    fetchPRForBranch: noopAsync(),
    enqueueGitHubPRRefresh: vi.fn(),
    updateRepo: noopAsync(),
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    beginGitBranchCompareRequest: vi.fn(() => 'request-key'),
    setGitBranchCompareResult: vi.fn(),
    clearGitBranchCompare: vi.fn(),
    fetchUpstreamStatus: noopAsync(),
    setUpstreamStatus: vi.fn(),
    pushBranch: noopAsync(),
    pullBranch: noopAsync(),
    fastForwardBranch: noopAsync(),
    syncBranch: noopAsync(),
    rebaseFromBase: noopAsync(),
    fetchBranch: noopAsync(),
    revealInExplorer: vi.fn(),
    trackConflictPath: vi.fn(),
    openDiff: vi.fn(),
    openFile: vi.fn(),
    setEditorViewMode: vi.fn(),
    setMarkdownViewMode: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    openConflictFile: vi.fn(),
    openConflictReview: vi.fn(),
    openBranchDiff: vi.fn(),
    createEmptySplitGroup: vi.fn(() => 'group-2'),
    openAllDiffs: vi.fn(),
    openBranchAllDiffs: vi.fn(),
    openCommitAllDiffs: vi.fn(),
    deleteDiffComment: noopAsync(true),
    clearDiffComments: noopAsync(true),
    clearDiffCommentsForFile: noopAsync(true),
    setScrollToDiffCommentId: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    allocateCommitMessageGenerationRequestId: vi.fn(() => 'commit-generation-1'),
    setCommitMessageGenerationRecord: vi.fn(),
    updateCommitMessageGenerationRecord: vi.fn(),
    pruneCommitMessageGenerationRecords: vi.fn(),
    allocatePullRequestGenerationRequestId: vi.fn(() => 'pr-generation-1'),
    setPullRequestGenerationRecord: vi.fn(),
    updatePullRequestGenerationRecord: vi.fn(),
    prunePullRequestGenerationRecords: vi.fn(),
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  resetState()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSourceControl(): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControl />
      </TooltipProvider>
    )
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function row(path: string, area: GitStatusEntry['area']): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(
    `[data-source-control-path="${path}"][data-source-control-area="${area}"]`
  )
}

function checkbox(el: HTMLElement | null): HTMLButtonElement | null {
  return el?.querySelector<HTMLButtonElement>('button[role="checkbox"]') ?? null
}

describe('SourceControl submodule child row checkbox', () => {
  it('renders a toggle checkbox on an expanded submodule real child row', async () => {
    mocks.getRuntimeGitSubmoduleStatus.mockResolvedValue({
      entries: [gitEntry({ path: 'inner.ts', area: 'unstaged' })]
    })
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [submoduleEntry()]
      }
    })
    renderSourceControl()

    const parentRow = row('sub', 'unstaged')
    expect(parentRow).not.toBeNull()
    // Expand the dirty submodule (single click toggles expansion).
    act(() => {
      parentRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const childRow = row('sub/inner.ts', 'unstaged')
    expect(childRow).not.toBeNull()
    const cb = checkbox(childRow)
    expect(cb).not.toBeNull()
    expect(cb?.getAttribute('aria-checked')).toBe('false')
  })

  it('clicking the child-row checkbox toggles selection state', async () => {
    mocks.getRuntimeGitSubmoduleStatus.mockResolvedValue({
      entries: [gitEntry({ path: 'inner.ts', area: 'unstaged' })]
    })
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [submoduleEntry()]
      }
    })
    renderSourceControl()

    act(() => {
      row('sub', 'unstaged')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const childRow = row('sub/inner.ts', 'unstaged')
    const cb = checkbox(childRow)
    expect(cb?.getAttribute('aria-checked')).toBe('false')

    act(() => {
      cb?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(checkbox(childRow)?.getAttribute('aria-checked')).toBe('true')

    act(() => {
      checkbox(childRow)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(checkbox(childRow)?.getAttribute('aria-checked')).toBe('false')
  })

  it('does not render a checkbox on a loading submodule placeholder row', async () => {
    // Never resolves -> the expanded submodule stays in its loading placeholder.
    mocks.getRuntimeGitSubmoduleStatus.mockImplementation(
      () => new Promise(() => {})
    )
    resetState({
      gitStatusByWorktree: {
        [mocks.activeWorktree.id]: [submoduleEntry()]
      }
    })
    renderSourceControl()

    act(() => {
      row('sub', 'unstaged')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const placeholder = container.querySelector('[data-source-control-path="sub/inner.ts"]')
    expect(placeholder).toBeNull()
    expect(container.querySelectorAll('button[role="checkbox"]').length).toBe(0)
  })
})
