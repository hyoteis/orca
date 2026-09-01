import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import {
  LocalLanguageServerSessionManager,
  resolveDefaultLocalLanguageServerCommand
} from './local-language-server-session-manager'
import type {
  LanguageServerLaunchRequest,
  LanguageServerSessionEvent
} from '../../shared/language-server-session'

const launch = (
  overrides: Partial<LanguageServerLaunchRequest> = {}
): LanguageServerLaunchRequest => ({
  sessionId: 's',
  scopeId: 'scope',
  revision: 1,
  kind: 'clangd',
  workspaceRoot: tmpdir(),
  executionHostId: 'local',
  members: [],
  ...overrides
})

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out'))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

describe('LocalLanguageServerSessionManager', () => {
  it('resolves only known language-server commands', () => {
    expect(resolveDefaultLocalLanguageServerCommand(launch())).toEqual({
      executable: 'clangd',
      args: [],
      cwd: tmpdir()
    })
    expect(
      resolveDefaultLocalLanguageServerCommand(
        launch({ command: { executable: '/custom/clangd', args: ['--background-index'] } })
      )
    ).toEqual({
      executable: '/custom/clangd',
      args: ['--background-index'],
      cwd: tmpdir()
    })
  })

  it('streams bytes and terminates the owned process', async () => {
    const events: LanguageServerSessionEvent[] = []
    const manager = new LocalLanguageServerSessionManager(
      (_sessionId, event) => events.push(event),
      (request) => ({
        executable: process.execPath,
        args: [
          '-e',
          "process.stdin.on('data', b => process.stdout.write(b)); process.stderr.write('ready')"
        ],
        cwd: request.workspaceRoot
      }),
      { closeTimeoutMs: 100 }
    )
    manager.open(launch({ sessionId: 'session-1' }))
    await waitFor(() =>
      events.some((event) => event.type === 'status' && event.status.type === 'ready')
    )
    expect(manager.send('session-1', new TextEncoder().encode('hello'))).toBe(true)
    await waitFor(() => events.some((event) => event.type === 'stdout'))
    const stdout = events.find((event) => event.type === 'stdout')
    expect(stdout && new TextDecoder().decode(stdout.bytes)).toBe('hello')
    expect(events.some((event) => event.type === 'status' && event.status.type === 'stderr')).toBe(
      true
    )
    manager.close('session-1')
    await waitFor(() =>
      events.some((event) => event.type === 'status' && event.status.type === 'exit')
    )
  })

  it('rejects duplicate sessions and relative workspace roots', () => {
    const manager = new LocalLanguageServerSessionManager(
      () => undefined,
      (request) => ({
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 1000)'],
        cwd: request.workspaceRoot
      })
    )
    expect(() => manager.open(launch({ sessionId: 'bad', workspaceRoot: 'relative' }))).toThrow(
      'must be absolute'
    )
  })
})
