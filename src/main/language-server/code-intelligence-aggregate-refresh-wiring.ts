import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
import type { CodeIntelligenceScopeStore } from './code-intelligence-scope-store'
import { AggregateRefreshCoordinator } from './code-intelligence-aggregate-refresh'
import { subscribeViaWatcherProcess } from '../ipc/parcel-watcher-process'

/** Local watch seam — tests mock it; production rides the crash-isolated
 * watcher process (direct @parcel/watcher in Electron main silently delivers
 * nothing on Windows; electron#7547). */
export type LocalWatchSubscribe = (
  directory: string,
  onChange: (changed: readonly string[]) => void
) => Promise<() => void>

const parcelSubscribe: LocalWatchSubscribe = async (directory, onChange) => {
  const subscription = await subscribeViaWatcherProcess(
    directory,
    (error, events) => {
      if (error || events.length === 0) {
        return
      }
      onChange(events.map((event) => event.path))
    },
    {}
  )
  return () => void subscription.unsubscribe()
}

let coordinatorSingleton: AggregateRefreshCoordinator | null = null

export function getAggregateRefreshCoordinator(): AggregateRefreshCoordinator {
  coordinatorSingleton ??= new AggregateRefreshCoordinator()
  return coordinatorSingleton
}

/** Local drift probe — mtime+size per database, null when unreadable. */
export const localAggregateDriftProbe = async (
  paths: readonly string[]
): Promise<(string | null)[]> =>
  Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path)
        return `${info.mtimeMs}:${info.size}`
      } catch {
        return null
      }
    })
  )

/** Watches the directories holding mapped databases and feeds change events
 * into the coordinator. One subscription per distinct directory; scope syncs
 * unsubscribe directories nobody maps anymore. */
export class LocalAggregateWatchSet {
  private readonly subscriptions = new Map<string, Promise<() => void>>()

  constructor(private readonly subscribe: LocalWatchSubscribe = parcelSubscribe) {}

  async sync(databasePaths: readonly string[], onChange: (changed: readonly string[]) => void): Promise<void> {
    const wanted = new Set(databasePaths.map(dirname))
    for (const directory of wanted) {
      if (!this.subscriptions.has(directory)) {
        // Why keep the promise: unsubscribe must await native teardown, and a
        // sync racing the first subscription must not double-subscribe.
        this.subscriptions.set(
          directory,
          this.subscribe(directory, onChange).catch(() => async () => {})
        )
      }
    }
    for (const [directory, unsubscribePromise] of this.subscriptions) {
      if (!wanted.has(directory)) {
        this.subscriptions.delete(directory)
        void (await unsubscribePromise)()
      }
    }
  }

  async dispose(): Promise<void> {
    const pending = [...this.subscriptions.values()]
    this.subscriptions.clear()
    await Promise.all(pending.map((promise) => promise.then((unsubscribe) => unsubscribe())))
  }
}

/** Track/untrack every cpp scope's mapped databases with the coordinator and
 * refresh the local directory watch set. SSH scopes still track — their events
 * arrive through the provider-watch hook and their rebuild is the same
 * callback; only the local file events come from the watch set. */
export async function syncAggregateRefreshTracking(args: {
  scopes: CodeIntelligenceScopeStore
  watch: LocalAggregateWatchSet
  rebuild: (scope: CodeIntelligenceScope) => Promise<void>
}): Promise<void> {
  const coordinator = getAggregateRefreshCoordinator()
  const scopes = args.scopes.list().filter((scope) => scope.language === 'cpp')
  const tracked = new Set<string>()
  const localPaths: string[] = []
  for (const scope of scopes) {
    const databases = scope.members
      .map((member) => member.compileDatabase)
      .filter((path): path is string => path !== undefined)
    coordinator.track(scope.id, databases, async (scopeId) => {
      const current = args.scopes.list().find((candidate) => candidate.id === scopeId)
      if (current) {
        await args.rebuild(current)
      }
    })
    if (databases.length > 0) {
      tracked.add(scope.id)
      if (scope.executionHostId === 'local') {
        localPaths.push(...databases)
      }
    }
  }
  for (const scope of args.scopes.list()) {
    if (!tracked.has(scope.id)) {
      coordinator.untrack(scope.id)
    }
  }
  await args.watch.sync(localPaths, (changed) => coordinator.handleFileChange(changed))
}
