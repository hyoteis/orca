import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type {
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'

export type FetchManagedArchiveResponse = {
  ok: boolean
  status: number
  body?: ReadableStream<Uint8Array>
}
/** Seam for tests; production uses Electron net.fetch, which honors the
 * system/Host proxy settings. */
export type FetchManagedArchive = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<FetchManagedArchiveResponse>

export async function defaultFetchManagedArchive(
  url: string,
  init: { signal: AbortSignal }
): Promise<FetchManagedArchiveResponse> {
  let response: Response
  try {
    // Electron net honors system/Host proxy settings.
    const { net } = await import('electron')
    response = await net.fetch(url, init)
  } catch {
    // Non-Electron Hosts (relay server) use Node's global fetch.
    response = await fetch(url, init)
  }
  return { ok: response.ok, status: response.status, body: response.body ?? undefined }
}

type ProgressReporter = (receivedBytes: number, totalBytes: number) => void

/**
 * Streams a route's archive to `destination` while hashing and size-capping
 * it against the trusted manifest entry. Every acquisition path (Host
 * download, Client file, offline archive) converges here before extraction.
 */
export async function writeVerifiedManagedArchive(args: {
  entry: ManagedLanguageServerManifestEntry
  route: ManagedLanguageServerInstallRoute
  destination: string
  fetchArchive?: FetchManagedArchive
  signal?: AbortSignal
  onProgress?: ProgressReporter
}): Promise<void> {
  const { entry } = args
  let source: Readable
  if (args.route.type === 'host-download') {
    const response = await (args.fetchArchive ?? defaultFetchManagedArchive)(
      entry.sourceUrl,
      { signal: args.signal ?? new AbortController().signal }
    )
    if (!response.ok || !response.body) {
      throw new Error(`Archive download failed with HTTP ${String(response.status)}`)
    }
    source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  } else {
    const fileStat = await stat(args.route.filePath)
    if (fileStat.size !== entry.sizeBytes) {
      throw new Error(
        `Selected file is ${String(fileStat.size)} bytes but the trusted manifest expects ${String(entry.sizeBytes)}`
      )
    }
    source = createReadStream(args.route.filePath)
  }
  await verifyStream(source, args)
}

async function verifyStream(source: Readable, args: {
  entry: ManagedLanguageServerManifestEntry
  destination: string
  signal?: AbortSignal
  onProgress?: ProgressReporter
}): Promise<void> {
  const { entry } = args
  const hash = createHash('sha256')
  let received = 0
  let lastReported = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > entry.sizeBytes) {
        callback(new Error('Archive exceeds the trusted manifest size'))
        return
      }
      hash.update(chunk)
      if (args.onProgress && (lastReported === 0 || received - lastReported >= 512 * 1024)) {
        lastReported = received
        args.onProgress(received, entry.sizeBytes)
      }
      callback(null, chunk)
    }
  })
  await pipeline(source, counter, createWriteStream(args.destination), { signal: args.signal })
  if (received !== entry.sizeBytes) {
    throw new Error(
      `Archive transfer ended at ${String(received)} of ${String(entry.sizeBytes)} expected bytes`
    )
  }
  const digest = hash.digest('hex')
  if (digest !== entry.sha256) {
    throw new Error(
      'Archive sha256 does not match the trusted manifest; it may be corrupt or a wrong-platform build'
    )
  }
}
