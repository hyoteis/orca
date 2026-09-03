import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { NightlyLspClient, resolveNightlyServerCommand } from './lsp-roundtrip'

const serverScript = join(import.meta.dirname, 'fake-lsp-server.mjs')
let client: NightlyLspClient | null = null

afterEach(() => {
  client?.dispose()
  client = null
})

function fakeClient(hoverDelayMs: number): NightlyLspClient {
  const spawned = new NightlyLspClient(
    { executable: process.execPath, args: [serverScript] },
    { FAKE_LSP_HOVER_DELAY_MS: String(hoverDelayMs) }
  )
  client = spawned
  return spawned
}

const hoverParams = {
  textDocument: { uri: 'file:///w/a.py' },
  position: { line: 0, character: 0 }
}

describe('NightlyLspClient framing', () => {
  it('round-trips initialize + initialized against the fake server', async () => {
    const spawned = fakeClient(0)
    const result = await spawned.initialize('file:///w')
    expect(result.capabilities).toEqual({ hoverProvider: true })
    expect(spawned.pendingRequestCount).toBe(0)
  })

  it('correlates responses by id across interleaved requests', async () => {
    const spawned = fakeClient(0)
    await spawned.initialize('file:///w')
    const [first, second] = await Promise.all([
      spawned.request('ping/hover', { n: 1 }),
      spawned.request('ping/hover', { n: 2 })
    ])
    expect(first).toEqual({ contents: { kind: 'plaintext', value: 'fake' } })
    expect(second).toEqual(first)
  })

  it('cancels a pending request and reports the cancel round-trip latency', async () => {
    const spawned = fakeClient(5_000)
    await spawned.initialize('file:///w')
    const pending = spawned.request('textDocument/hover', hoverParams)
    await new Promise((resolveDone) => setTimeout(resolveDone, 50))
    const cancelSentAt = performance.now()
    spawned.cancel(pending.id)
    const rejection = (await pending.catch((error: Error & { roundTripMs: number }) => error)) as {
      code: number
      roundTripMs: number
    }
    expect(rejection.code).toBe(-32800)
    expect(rejection.roundTripMs).toBeGreaterThan(0)
    expect(rejection.roundTripMs).toBeLessThan(2_000)
    // The reported window stays inside the wall clock since cancel was sent.
    expect(rejection.roundTripMs).toBeLessThanOrEqual(performance.now() - cancelSentAt + 1)
  })

  it('rejects pending requests and exits cleanly on dispose', async () => {
    const spawned = fakeClient(60_000)
    await spawned.initialize('file:///w')
    const pending = spawned.request('textDocument/hover', hoverParams)
    const exitElapsed = await spawned.dispose()
    expect(exitElapsed).toBeLessThan(5_000)
    await expect(pending).rejects.toThrow(/exited/)
    expect(spawned.pendingRequestCount).toBe(0)
  })
})

describe('resolveNightlyServerCommand', () => {
  it('honors explicit env overrides before PATH lookup', () => {
    expect(resolveNightlyServerCommand('clangd', { ORCA_NIGHTLY_CLANGD: '/x/clangd' })).toBe(
      '/x/clangd'
    )
    expect(resolveNightlyServerCommand('clangd', {})).toBe('clangd')
  })
})
