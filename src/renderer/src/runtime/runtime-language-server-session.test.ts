import { beforeEach, describe, expect, it, vi } from 'vitest'
const supports = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: supports }))
import { openRuntimeLanguageServerSession } from './runtime-language-server-session'
describe('openRuntimeLanguageServerSession', () => {
  beforeEach(() => supports.mockReset())
  it('does not subscribe against an old Host', async () => {
    supports.mockResolvedValue(false)
    const api = { subscribe: vi.fn() } as never
    await expect(
      openRuntimeLanguageServerSession(
        api,
        'old',
        { sessionId: 's', kind: 'clangd', workspaceRoot: '/repo', executionHostId: 'runtime:old' },
        { onEvent: vi.fn() }
      )
    ).rejects.toThrow('does not support')
    expect((api as { subscribe: ReturnType<typeof vi.fn> }).subscribe).not.toHaveBeenCalled()
  })
  it('bridges binary/status and closes the dedicated subscription', async () => {
    supports.mockResolvedValue(true)
    const callbacks: Record<string, (value?: unknown) => void> = {}
    const handle = { sendBinary: vi.fn(), unsubscribe: vi.fn() }
    const api = {
      subscribe: vi.fn(async (_args: unknown, next: Record<string, (value?: unknown) => void>) => {
        Object.assign(callbacks, next)
        return handle
      })
    }
    const onEvent = vi.fn()
    const session = await openRuntimeLanguageServerSession(
      api as never,
      'env',
      { sessionId: 's', kind: 'clangd', workspaceRoot: '/repo', executionHostId: 'runtime:env' },
      { onEvent }
    )
    callbacks.onBinary?.(new Uint8Array([1]))
    callbacks.onResponse?.({ ok: true, result: { status: { type: 'starting' } } })
    expect(onEvent).toHaveBeenCalledTimes(2)
    session.send(new Uint8Array([2]))
    session.close()
    expect(handle.sendBinary).toHaveBeenCalled()
    expect(handle.unsubscribe).toHaveBeenCalled()
  })
})
