import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClangdSession, openClangdSession } from './clangd-session'
import type { ClangdVersionGateResult } from './clangd-launch'
import type { CompileDbStrategy, CompileDbStrategyFactory } from './language-server-host-types'
import type { LanguageServerHostAdapter } from './language-server-host-adapter'
import {
  createLanguageServerHost,
  LANGUAGE_SERVER_IDLE_TIMEOUT_MS,
  type ClangdVersionGate,
  type LanguageServerHost
} from './language-server-host'
import type { LanguageServerDocumentChange } from '../../shared/language-server-navigation-types'

type SessionStub = {
  session: ClangdSession
  startCalls: { program: string; rootPath: string }[]
}

function stubSession(overrides: Partial<ClangdSession> = {}): SessionStub {
  const startCalls: { program: string; rootPath: string }[] = []
  let version = 1
  const session = {
    serverVersion: '23.1.0-test',
    rootPath: '',
    died: null,
    hasDocument: () => true,
    didOpen: () => {
      version = 1
    },
    didChange: (_filePath: string, requestedVersion: number) => {
      version = Math.max(version + 1, requestedVersion)
      return version
    },
    didClose: () => {},
    definition: vi.fn(async () => []),
    references: vi.fn(async () => []),
    declaration: vi.fn(async () => []),
    hover: vi.fn(async () => null),
    stop: vi.fn(async () => {}),
    ...overrides
  } as unknown as ClangdSession
  return { session, startCalls }
}

/** A no-op db strategy so lifecycle tests stay focused on session mechanics. */
function noopDbStrategyFactory(): CompileDbStrategyFactory {
  return () =>
    ({
      resolve: async () => ({ compileCommandsDir: null, degraded: false }),
      dispose: () => {}
    }) as unknown as CompileDbStrategy
}

/** An always-ok version gate so lifecycle tests skip the real clangd probe. */
function okVersionGate(): ClangdVersionGate {
  return async () => ({ kind: 'ok', major: 18, message: null })
}

function hostFrom(stub: SessionStub): LanguageServerHost {
  return createLanguageServerHost(
    {},
    (async (options) => {
      stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
      return stub.session
    }) as unknown as typeof openClangdSession,
    okVersionGate(),
    noopDbStrategyFactory()
  )
}

const CHANGE: LanguageServerDocumentChange = {
  range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
  text: 'x'
}

describe('createLanguageServerHost', () => {
  it('starts one session per worktree root and routes documents to it', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'd:\\proj-a',
      filePath: 'D:\\proj-a\\src\\main.cpp',
      text: 'x'
    })
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:/proj-a/src/util.cpp',
      text: 'y'
    })
    expect(stub.startCalls).toHaveLength(1)
    expect(stub.startCalls[0]?.rootPath).toBe('D:\\proj-a')
    expect(host.sessionCount).toBe(1)

    // Same-path canonicalization across separator/case spellings routes home.
    expect(
      host.changeDocument({ filePath: 'd:/proj-a/src/main.cpp', version: 2, changes: [CHANGE] }).ok
    ).toBe(true)
    const definition = await host.definition({
      filePath: 'D:/proj-a/src/util.cpp',
      position: { line: 0, character: 0 }
    })
    expect(definition).toEqual([])
    // S4: references + declaration route to the same session as definition.
    const references = await host.references({
      filePath: 'D:/proj-a/src/util.cpp',
      position: { line: 0, character: 0 }
    })
    expect(references).toEqual([])
    const declaration = await host.declaration({
      filePath: 'D:/proj-a/src/util.cpp',
      position: { line: 0, character: 0 }
    })
    expect(declaration).toEqual([])
    expect(stub.session.definition).toHaveBeenCalled()
    expect(stub.session.references).toHaveBeenCalled()
    expect(stub.session.declaration).toHaveBeenCalled()

    expect(host.closeDocument({ filePath: 'D:\\proj-a\\src\\main.cpp' }).ok).toBe(true)
  })

  it('starts a second session for a different worktree root', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:\\proj-a\\a.cpp',
      text: 'x'
    })
    await host.openDocument({
      worktreeRoot: 'D:\\proj-b',
      filePath: 'D:\\proj-b\\b.cpp',
      text: 'y'
    })
    expect(stub.startCalls.map((call) => call.rootPath)).toEqual(['D:\\proj-a', 'D:\\proj-b'])
    expect(host.sessionCount).toBe(2)
  })

  it('fails closed for changes/requests on documents with no session', () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    const result = host.changeDocument({
      filePath: 'D:\\nowhere\\x.cpp',
      version: 1,
      changes: [CHANGE]
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('no language-server session')
  })

  it('rejects references/declaration for documents with no session (IPC catches -> ok:false)', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await expect(
      host.references({ filePath: 'D:\\nowhere\\x.cpp', position: { line: 0, character: 0 } })
    ).rejects.toThrow(/no language-server session/)
    await expect(
      host.declaration({ filePath: 'D:\\nowhere\\x.cpp', position: { line: 0, character: 0 } })
    ).rejects.toThrow(/no language-server session/)
  })

  it('semanticTokens racing a cold session start joins the pending start instead of failing (#209 stuck-empty)', async () => {
    // Cold start: the renderer's token fetch reaches the host while
    // openDocument is still awaiting the (slow, e.g. SSH) session start.
    // Failing fast here made Monaco cache an empty result until an edit.
    const tokens = {
      tokenTypes: ['function'],
      tokenModifiers: [],
      tokens: [{ line: 0, char: 0, length: 3, type: 'function', modifiers: [] }]
    }
    const stub = stubSession({ semanticTokensFull: vi.fn(async () => tokens) })
    let resolveStart!: (session: ClangdSession) => void
    const startGate = new Promise<ClangdSession>((resolve) => {
      resolveStart = resolve
    })
    const host = createLanguageServerHost(
      {},
      (async () => startGate) as unknown as typeof openClangdSession,
      okVersionGate(),
      noopDbStrategyFactory()
    )

    const openPromise = host.openDocument({ worktreeRoot: '/wt', filePath: '/wt/a.cpp', text: 'x' })
    // Fetch arrives before the session start resolves.
    const tokensPromise = host.semanticTokens({ filePath: '/wt/a.cpp' })
    resolveStart(stub.session)

    const [openResult, result] = await Promise.all([openPromise, tokensPromise])
    expect(openResult.ok).toBe(true)
    expect(result).toEqual(tokens)
    expect(stub.session.semanticTokensFull).toHaveBeenCalledWith('/wt/a.cpp')
  })

  it('still rejects semanticTokens for documents with no pending start either', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await expect(host.semanticTokens({ filePath: 'D:\\nowhere\\x.cpp' })).rejects.toThrow(
      /no language-server session/
    )
  })

  it('forwards status events from the session', async () => {
    const statuses: (string | null)[] = []
    const statusEmitter: { emit: ((text: string | null) => void) | null } = { emit: null }
    const stub = stubSession()
    const host = createLanguageServerHost(
      { onStatus: (text) => statuses.push(text) },
      (async (options) => {
        statusEmitter.emit = options.onStatus ?? null
        return stub.session
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      noopDbStrategyFactory()
    )
    await host.openDocument({ worktreeRoot: 'D:\\p', filePath: 'D:\\p\\a.cpp', text: 'x' })
    statusEmitter.emit?.('clangd: indexing 10%')
    statusEmitter.emit?.(null)
    expect(statuses).toEqual(['clangd: indexing 10%', null])
  })

  it('shutdownAll stops every session once', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:\\proj-a\\a.cpp',
      text: 'x'
    })
    await host.shutdownAll()
    expect(stub.session.stop).toHaveBeenCalledTimes(1)
    expect(host.sessionCount).toBe(0)
  })

  it('reports a failed session start as ok:false instead of throwing', async () => {
    const host = createLanguageServerHost(
      {},
      (async () => {
        throw new Error('clangd not found')
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      noopDbStrategyFactory()
    )
    const result = await host.openDocument({
      worktreeRoot: 'D:\\p',
      filePath: 'D:\\p\\a.cpp',
      text: 'x'
    })
    expect(result).toEqual({ ok: false, error: 'clangd not found' })
    expect(host.sessionCount).toBe(0)
    // A later open retries the start instead of caching the failure forever.
    expect(
      host.changeDocument({ filePath: 'D:\\p\\a.cpp', version: 2, changes: [CHANGE] }).ok
    ).toBe(false)
  })

  it('routes external documents through the session that opened them', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj',
      filePath: 'C:\\Program Files\\STL\\chrono',
      text: 'x'
    })
    expect(
      host.changeDocument({
        filePath: 'c:/Program Files/STL/chrono',
        version: 2,
        changes: [CHANGE]
      }).ok
    ).toBe(true)
  })
})

describe('createLanguageServerHost — prewarm (spec D6)', () => {
  it('starts the session on the first C/C++ didOpen, before any hover/definition', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    expect(host.sessionCount).toBe(0)
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    expect(stub.startCalls).toHaveLength(1)
    expect(stub.session.definition).not.toHaveBeenCalled()
    expect(stub.session.hover).not.toHaveBeenCalled()
  })
})

describe('createLanguageServerHost — idle shutdown (spec D6)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shuts the session down 10min after its last C/C++ document closes (no orphan)', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    expect(stub.session.stop).not.toHaveBeenCalled()

    host.closeDocument({ filePath: 'D:/p/a.cpp' })
    expect(stub.session.stop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS - 1)
    expect(stub.session.stop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(stub.session.stop).toHaveBeenCalledTimes(1)
    expect(host.sessionCount).toBe(0)
  })

  it('cancels the idle timer when a document re-opens before the deadline', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    host.closeDocument({ filePath: 'D:/p/a.cpp' })
    await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS - 1000)

    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'y' })
    await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS)
    expect(stub.session.stop).not.toHaveBeenCalled()
  })

  it('only arms the timer once ALL of a worktree C/C++ documents close', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/b.cpp', text: 'y' })
    host.closeDocument({ filePath: 'D:/p/a.cpp' })
    await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS)
    expect(stub.session.stop).not.toHaveBeenCalled()
    host.closeDocument({ filePath: 'D:/p/b.cpp' })
    await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS)
    expect(stub.session.stop).toHaveBeenCalledTimes(1)
  })
})

describe('createLanguageServerHost — LRU cap (spec D6)', () => {
  it('evicts the most-idle session + emits a toast when a 4th worktree opens', async () => {
    const stopped: string[] = []
    const toasts: string[] = []
    const stubs = [stubSession(), stubSession(), stubSession(), stubSession()]
    stubs.forEach((stub, index) => {
      stub.session.stop = vi.fn(async () => {
        stopped.push(`wt-${index}`)
      })
    })
    let next = 0
    const host = createLanguageServerHost(
      { onToast: (message) => toasts.push(message) },
      (async (options) => {
        const stub = stubs[next] ?? stubs[0]
        next += 1
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      noopDbStrategyFactory()
    )

    await host.openDocument({ worktreeRoot: 'D:/wt0', filePath: 'D:/wt0/a.cpp', text: 'x' })
    await host.openDocument({ worktreeRoot: 'D:/wt1', filePath: 'D:/wt1/a.cpp', text: 'x' })
    await host.openDocument({ worktreeRoot: 'D:/wt2', filePath: 'D:/wt2/a.cpp', text: 'x' })
    expect(host.sessionCount).toBe(3)

    await host.openDocument({ worktreeRoot: 'D:/wt3', filePath: 'D:/wt3/a.cpp', text: 'x' })
    expect(stopped).toEqual(['wt-0'])
    expect(host.sessionCount).toBe(3)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/evict|clangd|language server/i)
  })

  it('evicts the least-recently-active session, not the oldest-started', async () => {
    // LRU compares lastActivityMs with strict <: without a stepped clock the
    // touch below can land in the same millisecond as wt-1's open and the
    // test degenerates into "evict first-inserted".
    vi.useFakeTimers()
    try {
      const stopped: string[] = []
      const stubs = [stubSession(), stubSession(), stubSession(), stubSession()]
      stubs.forEach((stub, index) => {
        stub.session.stop = vi.fn(async () => {
          stopped.push(`wt-${index}`)
        })
      })
      let next = 0
      const host = createLanguageServerHost(
        {},
        (async (options) => {
          const stub = stubs[next] ?? stubs[0]
          next += 1
          stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
          return stub.session
        }) as unknown as typeof openClangdSession,
        okVersionGate(),
        noopDbStrategyFactory()
      )

      vi.setSystemTime(1_000)
      await host.openDocument({ worktreeRoot: 'D:/wt0', filePath: 'D:/wt0/a.cpp', text: 'x' })
      vi.setSystemTime(2_000)
      await host.openDocument({ worktreeRoot: 'D:/wt1', filePath: 'D:/wt1/a.cpp', text: 'x' })
      vi.setSystemTime(3_000)
      await host.openDocument({ worktreeRoot: 'D:/wt2', filePath: 'D:/wt2/a.cpp', text: 'x' })
      // Touch wt-0 (edit) so it becomes most-recent; wt-1 is now least-recent.
      vi.setSystemTime(4_000)
      host.changeDocument({ filePath: 'D:/wt0/a.cpp', version: 2, changes: [CHANGE] })

      vi.setSystemTime(5_000)
      await host.openDocument({ worktreeRoot: 'D:/wt3', filePath: 'D:/wt3/a.cpp', text: 'x' })
      expect(stopped).toEqual(['wt-1'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createLanguageServerHost — version gate (spec D7)', () => {
  it('refuses to start when the gate rejects and surfaces the install hint', async () => {
    const degraded: (string | null)[] = []
    const rejectGate = async (): Promise<ClangdVersionGateResult> => ({
      kind: 'reject',
      major: null,
      message: 'install clangd 12+'
    })
    const host = createLanguageServerHost(
      { onDegraded: (message) => degraded.push(message) },
      undefined,
      rejectGate,
      noopDbStrategyFactory()
    )
    const result = await host.openDocument({
      worktreeRoot: 'D:/p',
      filePath: 'D:/p/a.cpp',
      text: 'x'
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/clangd/i)
    expect(degraded).toContain('install clangd 12+')
    expect(host.sessionCount).toBe(0)
  })

  it('starts on suggest-upgrade but pushes the upgrade hint to degraded state', async () => {
    const degraded: (string | null)[] = []
    const stub = stubSession()
    const suggestGate = async (): Promise<ClangdVersionGateResult> => ({
      kind: 'suggest-upgrade',
      major: 13,
      message: 'consider an upgrade'
    })
    const host = createLanguageServerHost(
      { onDegraded: (message) => degraded.push(message) },
      (async (options) => {
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
      }) as unknown as typeof openClangdSession,
      suggestGate,
      noopDbStrategyFactory()
    )
    const result = await host.openDocument({
      worktreeRoot: 'D:/p',
      filePath: 'D:/p/a.cpp',
      text: 'x'
    })
    expect(result.ok).toBe(true)
    expect(degraded).toContain('consider an upgrade')
  })

  it('proceeds silently when the gate accepts', async () => {
    const degraded: (string | null)[] = []
    const stub = stubSession()
    const okGate = async (): Promise<ClangdVersionGateResult> => ({
      kind: 'ok',
      major: 18,
      message: null
    })
    const host = createLanguageServerHost(
      { onDegraded: (message) => degraded.push(message) },
      (async (options) => {
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
      }) as unknown as typeof openClangdSession,
      okGate,
      noopDbStrategyFactory()
    )
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    expect(degraded.filter((message) => message !== null)).toEqual([])
  })
})

describe('createLanguageServerHost — compile-db degraded state (spec §6, S3)', () => {
  it('routes a configure failure to onDegraded + onToast and still launches clangd', async () => {
    const degraded: (string | null)[] = []
    const toasts: string[] = []
    const stub = stubSession()
    const failingDbFactory: CompileDbStrategyFactory = (_root, hooks) =>
      ({
        resolve: async () => {
          hooks.onDegraded?.('降级：无编译数据库，导航限于单文件')
          hooks.onToast?.('CMake configure failed')
          return { compileCommandsDir: 'D:\\p\\build\\orca-lsp', degraded: true }
        },
        dispose: () => {}
      }) as unknown as CompileDbStrategy
    const host = createLanguageServerHost(
      { onDegraded: (m) => degraded.push(m), onToast: (m) => toasts.push(m) },
      (async (options) => {
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      failingDbFactory
    )
    const result = await host.openDocument({
      worktreeRoot: 'D:/p',
      filePath: 'D:/p/a.cpp',
      text: 'x'
    })
    // clangd still starts (single-file navigation has value).
    expect(result.ok).toBe(true)
    expect(stub.startCalls).toHaveLength(1)
    expect(degraded.some((m) => m !== null)).toBe(true)
    expect(toasts).toHaveLength(1)
  })

  it('passes the resolved compile-commands-dir to the clangd launch', async () => {
    const stub = stubSession()
    const dirDbFactory: CompileDbStrategyFactory = () =>
      ({
        resolve: async () => ({ compileCommandsDir: 'D:\\p\\build', degraded: false }),
        dispose: () => {}
      }) as unknown as CompileDbStrategy
    const host = createLanguageServerHost(
      {},
      (async (options) => {
        stub.startCalls.push({
          program: options.program,
          rootPath: options.rootPath
        })
        expect(options.args).toContain('--compile-commands-dir=D:\\p\\build')
        return stub.session
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      dirDbFactory
    )
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
  })

  it('disposes the db strategy when the session is dropped', async () => {
    let disposed = false
    const stub = stubSession()
    const trackingDbFactory: CompileDbStrategyFactory = () =>
      ({
        resolve: async () => ({ compileCommandsDir: null, degraded: false }),
        dispose: () => {
          disposed = true
        }
      }) as unknown as CompileDbStrategy
    const host = createLanguageServerHost(
      {},
      (async (options) => {
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      trackingDbFactory
    )
    await host.openDocument({ worktreeRoot: 'D:/p', filePath: 'D:/p/a.cpp', text: 'x' })
    await host.shutdownAll()
    expect(disposed).toBe(true)
  })
})

describe('createLanguageServerHost — SSH scope (ticket 17 / #209)', () => {
  /** Records every host-path argument the adapter receives. */
  function recordingSshAdapter() {
    const seen = { launchRoots: [] as string[], dbRoots: [] as string[] }
    const adapter: LanguageServerHostAdapter = {
      kind: 'ssh',
      normalizeKey: (p) => p,
      pathToLspUri: (p) => `file://${p}`,
      lspUriToPath: (uri) => uri.replace('file://', ''),
      resolveClangdProgram: () => 'clangd',
      resolveClangdVersionGate: async () => ({ kind: 'ok', major: 18, message: null }),
      buildLaunch: async (root) => {
        seen.launchRoots.push(root)
        return { program: 'clangd', args: [], cwd: root }
      },
      openProcess: () => {
        throw new Error('not reached — openSession is stubbed')
      },
      createDbStrategy: (root) => {
        seen.dbRoots.push(root)
        return {
          resolve: async () => ({ compileCommandsDir: null, degraded: false }),
          dispose: () => {}
        }
      }
    }
    return { adapter, seen }
  }

  it('passes the bare worktree root (never the ssh:<target>| composite key) to the adapter and session', async () => {
    const stub = stubSession()
    const { adapter, seen } = recordingSshAdapter()
    const host = createLanguageServerHost(
      {},
      (async (options) => {
        stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
        return stub.session
        // SAFETY: test stub satisfying only the options shape openClangdSession reads.
      }) as unknown as typeof openClangdSession,
      okVersionGate(),
      null,
      () => adapter
    )
    await host.openDocument({
      worktreeRoot: '/home/zwf/graphic_graphic_3d',
      filePath: '/home/zwf/graphic_graphic_3d/src/render_context.cpp',
      text: 'int main() {}',
      connectionId: 'ssh-1790402102340-b82hfw'
    })
    // The relay spawns clangd with launch.cwd — a composite key there is an
    // ENOENT on the remote host (#209): the session key must stay a map key.
    expect(seen.launchRoots).toEqual(['/home/zwf/graphic_graphic_3d'])
    expect(seen.dbRoots).toEqual(['/home/zwf/graphic_graphic_3d'])
    // initialize rootPath (recorded by the stub) must be the remote POSIX root.
    expect(stub.startCalls.map((c) => c.rootPath)).toEqual(['/home/zwf/graphic_graphic_3d'])
    // The session-table key keeps the ssh: scope so two hosts with the same
    // POSIX path do not collide.
    expect(host.sessionCount).toBe(1)
  })
})

describe('relay-loss session recovery (click-driven re-ensure)', () => {
  function recoveryHarness() {
    const session1 = stubSession()
    const session2 = stubSession()
    session1.session.didOpen = vi.fn()
    session2.session.didOpen = vi.fn()
    session1.session.definition = vi.fn(async () => [
      { path: '/wt/a.h', range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 } }
    ])
    session2.session.definition = vi.fn(async () => [
      { path: '/wt/a.h', range: { startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 4 } }
    ])
    const startCalls: { rootPath: string }[] = []
    const exitCallbacks: ((error: Error | null) => void)[] = []
    let gateKind: 'ok' | 'reject' = 'ok'
    const gate: ClangdVersionGate = async () =>
      gateKind === 'ok'
        ? { kind: 'ok', major: 18, message: null }
        : {
            kind: 'reject',
            major: null,
            message:
              'SSH relay is not connected. Reconnect the SSH target to enable C/C++ navigation.'
          }
    let nextSession = 0
    const host = createLanguageServerHost(
      {},
      (async (options) => {
        startCalls.push({ rootPath: options.rootPath })
        exitCallbacks.push(options.onExit)
        return nextSession++ === 0 ? session1.session : session2.session
        // SAFETY: test stub satisfying only the options shape openClangdSession reads.
      }) as unknown as typeof openClangdSession,
      gate,
      noopDbStrategyFactory()
    )
    return {
      host,
      startCalls,
      killSession: (error: Error) => {
        for (const exit of exitCallbacks.splice(0)) {
          exit(error)
        }
      },
      relayDown() {
        gateKind = 'reject'
      },
      relayBack() {
        gateKind = 'ok'
      },
      session1,
      session2
    }
  }

  it('rebuilds the session on the next navigation request after the relay returns', async () => {
    const h = recoveryHarness()
    await h.host.openDocument({ worktreeRoot: '/wt', filePath: '/wt/a.cpp', text: 'int a;' })
    await h.host.definition({ filePath: '/wt/a.cpp', position: { line: 0, character: 1 } })
    expect(h.session1.session.definition).toHaveBeenCalledTimes(1)

    // Relay loss kills the session; the tab stays open.
    h.killSession(new Error('protocol error: LSP frame without valid Content-Length'))
    h.relayDown()
    // While the relay is still down, navigation degrades (no session) but must
    // not wedge: the gate re-rejects per attempt.
    await expect(
      h.host.definition({ filePath: '/wt/a.cpp', position: { line: 0, character: 1 } })
    ).rejects.toThrow(/no language-server session owns/)

    // Relay returns: the very next click rebuilds the session and replays didOpen.
    h.relayBack()
    const locations = await h.host.definition({
      filePath: '/wt/a.cpp',
      position: { line: 0, character: 1 }
    })
    expect(h.startCalls).toHaveLength(2)
    expect(locations).toEqual([
      { path: '/wt/a.h', range: { startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 4 } }
    ])
    expect(h.session2.session.definition).toHaveBeenCalledTimes(1)
    expect(h.session2.session.didOpen).toHaveBeenCalledWith('/wt/a.cpp', 'int a;')
    expect(h.session1.session.definition).toHaveBeenCalledTimes(1)
  })

  it('keeps degrading gracefully while the relay stays gone', async () => {
    const h = recoveryHarness()
    await h.host.openDocument({ worktreeRoot: '/wt', filePath: '/wt/a.cpp', text: 'int a;' })
    h.killSession(new Error('transport lost'))
    h.relayDown()
    for (let i = 0; i < 3; i++) {
      await expect(
        h.host.hover({ filePath: '/wt/a.cpp', position: { line: 0, character: 1 } })
      ).rejects.toThrow(/no language-server session owns/)
    }
    // No session was spawned against a dead relay.
    expect(h.startCalls).toHaveLength(1)
  })
})
