type CacheEntry = {
  expiresAt: number
  directories: string[]
}

const DIRECTORY_CACHE_TTL_MS = 60_000
const directoryCache = new Map<string, CacheEntry>()
const pendingScans = new Map<string, Promise<string[]>>()

export async function getCachedCodeIntelligenceDirectories(args: {
  key: string
  force?: boolean
  loadDirectories: () => Promise<string[]>
  now?: number
}): Promise<string[]> {
  const now = args.now ?? Date.now()
  const cached = directoryCache.get(args.key)
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
    directoryCache.set(args.key, {
      directories,
      expiresAt: now + DIRECTORY_CACHE_TTL_MS
    })
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
