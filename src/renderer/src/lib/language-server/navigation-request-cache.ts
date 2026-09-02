/** Bounded, promise-level request dedupe shared by language navigation modules. */
export function cacheRequest<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  limit: number
): Promise<T> {
  const cached = cache.get(key)
  if (cached) {
    return cached
  }
  const request = load().catch((error) => {
    if (cache.get(key) === request) {
      cache.delete(key)
    }
    throw error
  })
  cache.set(key, request)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    } else {
      break
    }
  }
  return request
}

/** Cached load that rejects (and so evicts) on cancellation — a cancelled
 * result must never poison the cache for the next caller. */
export function cacheRequestCancellable<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  token: { isCancellationRequested?: boolean } | undefined,
  limit: number
): Promise<T> {
  return cacheRequest(cache, key, async () => {
    const result = await load()
    if (token?.isCancellationRequested) {
      throw new Error('request cancelled')
    }
    return result
  }, limit)
}

export function requestCacheKey(
  request: {
    worktreeId: string
    filePath: string
    documentVersion: number
    lineNumber: number
    column: number
  },
  includePosition: boolean
): string {
  const base = `${request.worktreeId}:${request.filePath}:${request.documentVersion}`
  return includePosition ? `${base}:${request.lineNumber}:${request.column}` : base
}
