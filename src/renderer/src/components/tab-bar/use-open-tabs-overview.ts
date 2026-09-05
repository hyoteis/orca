// Feeds the open-tabs overview dropdown from the store for a single worktree.

import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  buildOpenTabsOverviewGroups,
  type OpenTabsOverviewGroup
} from './open-tabs-overview-model'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchAgentState,
  selectOpenTabSearchEntryState
} from './open-tab-search-entries'

export type UseOpenTabsOverviewOptions = {
  enabled: boolean
  worktreeId: string
}

export type OpenTabsOverviewSnapshot = {
  groups: OpenTabsOverviewGroup[]
}

export function useOpenTabsOverview({
  enabled,
  worktreeId
}: UseOpenTabsOverviewOptions): OpenTabsOverviewSnapshot {
  // Why null while disabled: a closed popover stays stable across store churn.
  const state = useAppStore(
    useShallow((store) => (enabled ? selectOpenTabSearchEntryState(store, worktreeId) : null))
  )
  // Why snapshot: agent status is a high-frequency stream; the overview reads
  // launch metadata that stays stable while the popover is open.
  const agentState = useMemo(
    () => (enabled ? selectOpenTabSearchAgentState(useAppStore.getState()) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Refresh on open or tab-set changes, never agent-status churn.
    [enabled, state?.tabsByWorktree, state?.unifiedTabsByWorktree, worktreeId]
  )
  const groups = useMemo(
    () =>
      state && agentState
        ? buildOpenTabsOverviewGroups({
            ...buildOpenTabSearchEntries(state, agentState),
            terminalTabsById: new Map(
              (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
            )
          })
        : [],
    [agentState, state, worktreeId]
  )
  return { groups }
}
