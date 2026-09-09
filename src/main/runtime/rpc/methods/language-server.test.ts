import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_SERVER_CUSTOM_COMMAND_RUNTIME_CAPABILITY,
  LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { isStreamingMethod } from '../core'
import { ALL_RPC_METHODS } from './index'
import { resolveDefaultLocalLanguageServerCommand } from '../../../language-server/local-language-server-session-manager'
describe('languageServer.session RPC contract', () => {
  it('accepts future optional parameters from newer clients', () => {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'languageServer.session')
    expect(
      method?.params?.safeParse({
        sessionId: 's',
        kind: 'clangd',
        workspaceRoot: '/repo',
        futureOptionalField: true
      }).success
    ).toBe(true)
  })

  it('still parses python kinds from old clients (#132 wire tolerance)', () => {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'languageServer.session')
    // Mixed-version pairs: the wire schema keeps tolerating python kinds so an
    // old desktop holding python scopes degrades with a readable host error,
    // never a generic zod validation failure.
    expect(
      method?.params?.safeParse({
        sessionId: 's',
        kind: 'basedpyright',
        workspaceRoot: '/repo'
      }).success
    ).toBe(true)
    expect(
      method?.params?.safeParse({
        sessionId: 's',
        kind: 'pyright',
        workspaceRoot: '/repo'
      }).success
    ).toBe(true)
  })

  it('refuses a python-kind launch with the readable rejection (#132)', () => {
    // The zod layer passes the old client's request through; the Host-side
    // spawn refusal is what surfaces to it.
    expect(() =>
      resolveDefaultLocalLanguageServerCommand({
        sessionId: 's',
        scopeId: 'runtime',
        revision: 0,
        kind: 'basedpyright',
        workspaceRoot: '/repo',
        executionHostId: 'local',
        members: []
      })
    ).toThrow('no longer supported')
  })

  it('advertises a streaming capability-gated method', () => {
    expect(RUNTIME_CAPABILITIES).toContain(LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(LANGUAGE_SERVER_CUSTOM_COMMAND_RUNTIME_CAPABILITY)
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'languageServer.session')
    expect(method).toBeDefined()
    expect(method && isStreamingMethod(method)).toBe(true)
  })
})
