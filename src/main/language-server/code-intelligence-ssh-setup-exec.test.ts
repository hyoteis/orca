import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import {
  SshSetupConnectionError,
  SshSetupExecQueue,
  buildRemoteAtomicWriteCommand,
  buildRemoteDirectoryExistsCommand,
  buildRemoteGnDiscoveryCommand,
  buildRemoteMtimesCommand
} from './code-intelligence-ssh-setup-exec'

type FakeChannel = EventEmitter & {
  stderr: EventEmitter
  written: string[]
  ended: boolean
  write: (data: string) => void
  end: () => void
  close: () => void
}

function fakeChannel(echoByCommand: string, onClosed: () => void): FakeChannel {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    written: [] as string[],
    ended: false,
    end() {
      channel.ended = true
    },
    close() {
      channel.emit('close', 0)
    }
  }) as FakeChannel
  setTimeout(() => {
    channel.emit('data', Buffer.from(`out:${echoByCommand}`))
    channel.emit('close', 0)
    onClosed()
  }, 5)
  return channel
}

function fakeConnection(tracker: {
  commands: string[]
  active: number
  maxActive: number
}): SshConnection {
  return {
    exec: async (command: string) => {
      tracker.commands.push(command)
      tracker.active += 1
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active)
      return fakeChannel(command, () => {
        tracker.active -= 1
      })
    }
  } as unknown as SshConnection
}

describe('SshSetupExecQueue', () => {
  it('runs commands strictly serially even when callers race them', async () => {
    const tracker = { commands: [] as string[], active: 0, maxActive: 0 }
    const queue = new SshSetupExecQueue(fakeConnection(tracker))

    const results = await Promise.all([
      queue.exec('first'),
      queue.exec('second'),
      queue.exec('third')
    ])

    expect(tracker.maxActive).toBe(1)
    expect(tracker.commands).toEqual(['first', 'second', 'third'])
    expect(results.map((result) => result.stdout)).toEqual([
      'out:first',
      'out:second',
      'out:third'
    ])
    expect(results.every((result) => result.code === 0)).toBe(true)
  })

  it('writes file content through stdin with a cat > tmp && mv atomic swap', async () => {
    const scopeDirectory = '/home/dev/.orca/code-intelligence/cpp/scopes/abc123'
    const command = buildRemoteAtomicWriteCommand(scopeDirectory, 'compile_commands.json')
    expect(command).toBe(
      `cd '${scopeDirectory}' && cat > '.compile_commands.json.tmp' && mv '.compile_commands.json.tmp' 'compile_commands.json'`
    )

    const channels: FakeChannel[] = []
    const connection = {
      exec: async () => {
        const channel = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          written: [] as string[],
          ended: false,
          write(data: string) {
            channel.written.push(data)
          },
          end() {
            channel.ended = true
            channel.emit('close', 0)
          },
          close() {
            channel.emit('close', 0)
          }
        }) as FakeChannel
        channels.push(channel)
        return channel
      }
    } as unknown as SshConnection
    const queue = new SshSetupExecQueue(connection)

    const content = JSON.stringify([{ file: '/srv/project/main.cpp' }], null, 2)
    const result = await queue.exec(command, { stdin: content })

    expect(result.code).toBe(0)
    expect(channels[0]?.written).toEqual([content])
    expect(channels[0]?.ended).toBe(true)
  })

  it('POSIX-quotes hostile directory paths in generated commands', () => {
    const command = buildRemoteAtomicWriteCommand("/home/dev/my project/o'brien", 'compile_commands.json')
    expect(command).toBe(
      `cd '/home/dev/my project/o'\\''brien' && cat > '.compile_commands.json.tmp' && mv '.compile_commands.json.tmp' 'compile_commands.json'`
    )
  })

  it('maps transport failures to SshSetupConnectionError and keeps the queue usable', async () => {
    let calls = 0
    const connection = {
      exec: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('Not connected')
        }
        return fakeChannel('after-reconnect', () => {})
      }
    } as unknown as SshConnection
    const queue = new SshSetupExecQueue(connection)

    await expect(queue.exec('first')).rejects.toBeInstanceOf(SshSetupConnectionError)
    await expect(queue.exec('second')).resolves.toMatchObject({ code: 0, stdout: 'out:after-reconnect' })
  })

  it('treats a channel close without exit status as a connection failure', async () => {
    const connection = {
      exec: async () => {
        const channel = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          end: () => {},
          close: () => {
            channel.emit('close', null)
          }
        })
        setTimeout(() => channel.emit('close', null), 0)
        return channel
      }
    } as unknown as SshConnection
    const queue = new SshSetupExecQueue(connection)

    await expect(queue.capture('anything')).rejects.toBeInstanceOf(SshSetupConnectionError)
  })

  it('writeFile rejects when the atomic swap fails', async () => {
    const connection = {
      exec: async () => {
        const channel = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          write: () => {},
          end: () => {},
          close: () => channel.emit('close', 1)
        })
        setTimeout(() => {
          channel.stderr.emit('data', Buffer.from('mkdir: permission denied'))
          channel.emit('close', 1)
        }, 0)
        return channel
      }
    } as unknown as SshConnection
    const queue = new SshSetupExecQueue(connection)

    await expect(
      queue.writeFile('/home/dev/.orca/code-intelligence/cpp/scopes/abc', 'compile_commands.json', '[]')
    ).rejects.toThrow('mkdir: permission denied')
  })
})

describe('buildRemoteDirectoryExistsCommand', () => {
  it('quotes the directory for a POSIX test', () => {
    expect(buildRemoteDirectoryExistsCommand('/home/dev/.orca/cdb')).toBe(
      "test -d '/home/dev/.orca/cdb'"
    )
    expect(buildRemoteDirectoryExistsCommand("/path/it's")).toBe("test -d '/path/it'\\''s'")
  })
})

describe('buildRemoteGnDiscoveryCommand', () => {
  it('falls back from the PATH lookup to bundled candidate probes', () => {
    expect(
      buildRemoteGnDiscoveryCommand(['/srv/buildtools/linux64/gn', '/srv/buildtools/gn'])
    ).toBe(
      "command -v gn || { for c in '/srv/buildtools/linux64/gn' '/srv/buildtools/gn'; do [ -x \"$c\" ] && printf '%s\\n' \"$c\" && exit 0; done; exit 1; }"
    )
  })
})

describe('buildRemoteMtimesCommand', () => {
  it('stats every path in order, GNU-style on Linux', () => {
    expect(buildRemoteMtimesCommand(['/a', '/b'], 'Linux')).toBe(
      `for p in '/a' '/b'; do stat -c %Y "$p" 2>/dev/null || printf '0\\n'; done`
    )
  })

  it('switches to BSD stat flags on Darwin', () => {
    expect(buildRemoteMtimesCommand(['/a'], 'Darwin')).toBe(
      `for p in '/a'; do stat -f %m "$p" 2>/dev/null || printf '0\\n'; done`
    )
  })
})
