import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
import { CodeIntelligenceScopeStore } from './code-intelligence-scope-store'
import {
  LocalAggregateWatchSet,
  localAggregateDriftProbe,
  syncAggregateRefreshTracking,
  type LocalWatchSubscribe
} from './code-intelligence-aggregate-refresh-wiring'
import { getAggregateRefreshCoordinator } from './code-intelligence-aggregate-refresh-wiring'

const scope = (overrides: Partial<CodeIntelligenceScope> = {}): CodeIntelligenceScope => ({
  id: 'local:worktree:w:cpp',
  name: 'Engine',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members: [{ path: 'engine', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1,
  ...overrides
})

function createStore(initial: CodeIntelligenceScope[]) {
  let settings = { codeIntelligenceScopes: initial } as GlobalSettings
  return {
    getRepos: vi.fn(() => [
      {
        id: 'w',
        path: '/workspace',
        displayName: 'Workspace',
        connectionId: null,
        executionHostId: 'local',
        kind: 'git',
        badgeColor: '#000000',
        addedAt: 1
      }
    ]),
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

describe('syncAggregateRefreshTracking', () => {
  it('tracks mapped scopes, feeds local watch events through the coordinator, and untracks empties', async () => {
    vi.useFakeTimers()
    try {
      const rebuild = vi.fn(async () => {})
      const listeners = new Map<string, (changed: readonly string[]) => void>()
      const subscribe: LocalWatchSubscribe = async (directory, onChange) => {
        listeners.set(directory, onChange)
        return async () => {
          listeners.delete(directory)
        }
      }
      const mapped = scope({
        members: [
          { path: 'engine', visibleResults: true, compileDatabase: '/cdb/engine.json' },
          { path: 'tools', visibleResults: true }
        ]
      })
      const store = new CodeIntelligenceScopeStore(createStore([mapped]) as never)
      const watch = new LocalAggregateWatchSet(subscribe)

      await syncAggregateRefreshTracking({ scopes: store, watch, rebuild })
      // One directory watched — /cdb holds the only mapped database.
      expect([...listeners.keys()]).toEqual(['/cdb'])
      // Events for unrelated paths never fire the rebuild.
      listeners.get('/cdb')!(['/cdb/other.json'])
      await vi.advanceTimersByTimeAsync(600)
      expect(rebuild).not.toHaveBeenCalled()
      // A hit on the mapped database debounces into one single-flight rebuild.
      listeners.get('/cdb')!(['/cdb/engine.json', '/cdb/noise.tmp'])
      await vi.advanceTimersByTimeAsync(600)
      expect(rebuild).toHaveBeenCalledTimes(1)

      // Removing the mapping untracks and unwatches.
      store.upsert(scope({ members: [{ path: 'engine', visibleResults: true }] }))
      await syncAggregateRefreshTracking({ scopes: store, watch, rebuild })
      expect(listeners.size).toBe(0)
      expect(
        await getAggregateRefreshCoordinator().refreshIfDrifted('local:worktree:w:cpp', async () => [])
      ).toBe(false)
      await watch.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('local drift probe reports mtime+size and null for unreadable files', async () => {
    const [live, missing] = await localAggregateDriftProbe(['package.json', '/definitely/not/here.json'])
    expect(live).toMatch(/:\d+$/)
    expect(missing).toBeNull()
  })
})
