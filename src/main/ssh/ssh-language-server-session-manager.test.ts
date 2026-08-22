import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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
  write = vi.fn(() => true)
  end = vi.fn()
  close = vi.fn()
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
    ).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
  })
  it('streams bytes and owns channel cleanup', async () => {
    const events: LanguageServerSessionEvent[] = [],
      channel = new Channel(),
      connection = { exec: vi.fn(async () => channel) } as unknown as SshConnection
    const manager = new SshLanguageServerSessionManager(
      (_id, event) => events.push(event),
      (request) => ({ executable: 'clangd', args: [], cwd: request.workspaceRoot })
    )
    await manager.open(connection, { sessionId: 's', kind: 'clangd', workspaceRoot: '/repo' })
    channel.emit('data', Buffer.from('hello'))
    expect(events.some((event) => event.type === 'stdout')).toBe(true)
    expect(manager.send('s', new TextEncoder().encode('in'))).toBe(true)
    manager.close('s')
    expect(channel.end).toHaveBeenCalledOnce()
    expect(channel.close).toHaveBeenCalledOnce()
  })
})
