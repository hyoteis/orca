type CacheEntry = {
  expiresAt: number
  directories: string[]
}

type ScanCacheStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DIRECTORY_CACHE_TTL_MS = 10 * 60_000
const PERSISTED_STORAGE_KEY = 'orca.codeIntelligence.directoryScan.v1'
const PERSISTED_MAX_REPOS = 8
const PERSISTED_MAX_BYTES = 512 * 1024
const directoryCache = new Map<string, CacheEntry>()
const pendingScans = new Map<string, Promise<string[]>>()

function defaultStorage(): ScanCacheStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function readPersistedCache(storage: ScanCacheStorage | null): Record<string, CacheEntry> {
  if (!storage) {
    return {}
  }
  try {
    const raw = storage.getItem(PERSISTED_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePersistedCache(
  storage: ScanCacheStorage | null,
  entries: Record<string, CacheEntry>
): void {
  if (!storage) {
    return
  }
  // Why: keep only the newest few workspaces so one huge tree can't evict
  // everything else or blow the storage quota.
  const pruned = Object.entries(entries)
    .sort((left, right) => right[1].expiresAt - left[1].expiresAt)
    .slice(0, PERSISTED_MAX_REPOS)
  try {
    const serialized = JSON.stringify(Object.fromEntries(pruned))
    if (serialized.length <= PERSISTED_MAX_BYTES) {
      storage.setItem(PERSISTED_STORAGE_KEY, serialized)
    }
  } catch {
    // Quota/security failures just lose persistence for the next cold start.
  }
}

export async function getCachedCodeIntelligenceDirectories(args: {
  key: string
  force?: boolean
  loadDirectories: () => Promise<string[]>
  now?: number
  storage?: ScanCacheStorage | null
}): Promise<string[]> {
  const now = args.now ?? Date.now()
  const storage = args.storage === undefined ? defaultStorage() : args.storage
  const cached = directoryCache.get(args.key) ?? readPersistedCache(storage)[args.key] ?? null
  if (!args.force && cached && cached.expiresAt > now) {
    return [...cached.directories]
  }
  if (!args.force) {
    const pending = pendingScans.get(args.key)
    if (pending) {
      return [...(await pending)]
    }
  }
  const scan = args.loadDirectories().then((directories) => {
    const entry = { directories, expiresAt: now + DIRECTORY_CACHE_TTL_MS }
    directoryCache.set(args.key, entry)
    writePersistedCache(storage, { ...readPersistedCache(storage), [args.key]: entry })
    return directories
  })
  pendingScans.set(args.key, scan)
  try {
    return [...(await scan)]
  } finally {
    if (pendingScans.get(args.key) === scan) {
      pendingScans.delete(args.key)
    }
  }
}
