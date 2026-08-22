import { beforeEach, describe, expect, it, vi } from 'vitest'
const supports = vi.hoisted(() => vi.fn())
const authorizeSession = vi.fn()
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: supports }))
import { openRuntimeLanguageServerSession } from './runtime-language-server-session'
describe('openRuntimeLanguageServerSession', () => {
  beforeEach(() => {
    supports.mockReset()
    authorizeSession.mockReset()
    ;(globalThis as { window?: unknown }).window = {
      api: { codeIntelligence: { authorizeSession } }
    }
    authorizeSession.mockResolvedValue({
      sessionId: 's',
      scopeId: 'scope',
      revision: 1,
      kind: 'clangd',
      workspaceRoot: '/repo',
      executionHostId: 'runtime:env',
      members: [{ relativePath: '.', visibleResults: true }]
    })
  })
  it('does not subscribe against an old Host', async () => {
    supports.mockResolvedValue(false)
    const api = { subscribe: vi.fn() } as never
    await expect(
      openRuntimeLanguageServerSession(
        api,
        'old',
        { sessionId: 's', scopeId: 'scope', revision: 1 },
        { onEvent: vi.fn() }
      )
    ).rejects.toThrow('does not support')
    expect((api as { subscribe: ReturnType<typeof vi.fn> }).subscribe).not.toHaveBeenCalled()
  })
  it('does not send a custom command to a Host that did not advertise support', async () => {
    supports.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    authorizeSession.mockResolvedValueOnce({
      sessionId: 's',
      scopeId: 'scope',
      revision: 1,
      kind: 'clangd',
      workspaceRoot: '/repo',
      executionHostId: 'runtime:env',
      command: { executable: '/custom/clangd', args: [] },
      members: [{ relativePath: '.', visibleResults: true }]
    })
    const api = { subscribe: vi.fn() } as never
    await expect(
      openRuntimeLanguageServerSession(
        api,
        'env',
        { sessionId: 's', scopeId: 'scope', revision: 1 },
        { onEvent: vi.fn() }
      )
    ).rejects.toThrow('custom language-server commands')
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
      { sessionId: 's', scopeId: 'scope', revision: 1 },
      { onEvent }
    )
    callbacks.onBinary?.(new Uint8Array([1]))
    callbacks.onResponse?.({ ok: true, result: { status: { type: 'starting' } } })
    expect(onEvent).toHaveBeenCalledTimes(2)
    session.send(new Uint8Array([2]))
    session.close()
    expect(authorizeSession).toHaveBeenCalledWith({ sessionId: 's', scopeId: 'scope', revision: 1 })
    expect(api.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.not.objectContaining({
          members: expect.anything(),
          scopeId: expect.anything(),
          revision: expect.anything()
        })
      }),
      expect.any(Object)
    )
    expect(handle.sendBinary).toHaveBeenCalled()
    expect(handle.unsubscribe).toHaveBeenCalled()
  })
})
