import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { isStreamingMethod } from '../core'
import { ALL_RPC_METHODS } from './index'
describe('languageServer.session RPC contract', () => {
  it('advertises a streaming capability-gated method', () => {
    expect(RUNTIME_CAPABILITIES).toContain(LANGUAGE_SERVER_SESSION_RUNTIME_CAPABILITY)
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'languageServer.session')
    expect(method).toBeDefined()
    expect(method && isStreamingMethod(method)).toBe(true)
  })
})
