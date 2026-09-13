import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPosixLanguageServerCommand,
  buildWindowsLanguageServerCommand,
  SshLanguageServerSessionManager
} from './ssh-language-server-session-manager'
import type { SshConnection } from './ssh-connection'
import type { LanguageServerSessionEvent } from '../../shared/language-server-session'
class Channel extends EventEmitter {
  stderr = new EventEmitter()
  writableLength = 0
  write = vi.fn((_bytes: Buffer) => true)
  end = vi.fn()
  close = vi.fn()
}
const openSession = async (channel: Channel) => {
  const events: LanguageServerSessionEvent[] = []
  const connection = { exec: vi.fn(async () => channel) } as unknown as SshConnection
  const manager = new SshLanguageServerSessionManager(
    (id, event) => {
      if (id === 's') {
        events.push(event)
      }
    },
    (request) => ({ executable: 'clangd', args: [], cwd: request.workspaceRoot })
  )
  await manager.open(connection, {
    sessionId: 's',
    scopeId: 'scope',
    revision: 1,
    kind: 'clangd',
    workspaceRoot: '/repo',
    executionHostId: 'local',
    members: []
  })
  return { events, manager }
}

describe('SshLanguageServerSessionManager', () => {
  it('quotes structured commands without a user shell string', () => {
    expect(
      buildPosixLanguageServerCommand({
        executable: 'clangd',
        args: ['--query-driver=/a b/g++'],
        cwd: "/repo/it's"
      })
    ).toBe("cd '/repo/it'\\''s' && exec 'clangd' '--query-driver=/a b/g++'")
  })
  it('builds an explicit PowerShell wrapper for Windows hosts', () => {
    expect(
      buildWindowsLanguageServerCommand({
        executable: 'C:\\Tools\\clangd.cmd',
        args: ['--stdio'],
        cwd: 'C:\\repo'
      })
    ).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    const encoded = buildWindowsLanguageServerCommand({
      executable: 'C:\\Tools\\clangd.cmd',
      args: ['--stdio'],
      cwd: 'C:\\repo'
    })
      .split(' ')
      .at(-1)
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf16le')).toBe(
      "Set-Location -LiteralPath 'C:\\repo'; & 'C:\\Tools\\clangd.cmd' '--stdio'"
    )
  })
  it('streams bytes and owns channel cleanup', async () => {
    const channel = new Channel()
    const { events, manager } = await openSession(channel)
    channel.emit('data', Buffer.from('hello'))
    expect(events.some((event) => event.type === 'stdout')).toBe(true)
    expect(manager.send('s', new TextEncoder().encode('in'))).toBe(true)
    manager.close('s')
    expect(channel.end).toHaveBeenCalledOnce()
  })

  describe('close uses the LSP shutdown contract with a hard-close fallback (#182)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('writes shutdown+exit notifications and defers the hard close', async () => {
      const channel = new Channel()
      const { manager } = await openSession(channel)

      manager.close('s')

      const written = channel.write.mock.calls
        .map(([bytes]) => Buffer.from(bytes as Uint8Array).toString('utf8'))
        .join('')
      expect(written).toContain('"method":"shutdown"')
      expect(written).toContain('"method":"exit"')
      expect(written).toMatch(/Content-Length: \d+/)
      expect(channel.end).toHaveBeenCalledOnce()
      // EOF alone should get a chance to take the tree down first.
      expect(channel.close).not.toHaveBeenCalled()

      vi.advanceTimersByTime(2_000)
      expect(channel.close).toHaveBeenCalledOnce()
    })

    it('cancels the hard close when the remote exits on its own', async () => {
      const channel = new Channel()
      const { manager } = await openSession(channel)

      manager.close('s')
      channel.emit('close')
      vi.advanceTimersByTime(2_000)

      expect(channel.close).not.toHaveBeenCalled()
    })

    it('surfaces the remote exit status on a natural exit', async () => {
      const channel = new Channel()
      const { events } = await openSession(channel)

      channel.emit('exit', 0)
      channel.emit('close')

      const exitStatus = events.find((event) => event.type === 'status' && event.status.type === 'exit')
      expect(exitStatus).toMatchObject({ status: { type: 'exit', code: 0 } })
      expect(events.at(-1)).toMatchObject({ type: 'status', status: { type: 'closed' } })
    })

    it('does not double-report exit after an explicit close', async () => {
      const channel = new Channel()
      const { events, manager } = await openSession(channel)

      manager.close('s')
      channel.emit('exit', 0)
      channel.emit('close')
      vi.advanceTimersByTime(2_000)

      const exits = events.filter(
        (event) => event.type === 'status' && event.status.type === 'exit'
      )
      expect(exits).toEqual([])
      expect(
        events.filter((event) => event.type === 'status' && event.status.type === 'closed')
      ).toHaveLength(1)
    })
  })
})
