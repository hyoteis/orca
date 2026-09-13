import { describe, expect, it } from 'vitest'
import {
  CPP_INIT_FAILURE_TTL_MS as CPP_TTL,
  CppInitFailureCache,
  isTransientInitFailure
} from './cpp-init-failure-cache'

describe('cpp init failure cache (#164)', () => {
  it('caches nothing until a failure is recorded', () => {
    expect(new CppInitFailureCache().cached('scope')).toBeNull()
  })

  it('replays the recorded message with the cached prefix', () => {
    const cache = new CppInitFailureCache()
    cache.record('scope', 'clangd spawn failed: ENOENT', 1_000)
    const cached = cache.cached('scope', 1_000 + 1)
    expect(cached).toBeInstanceOf(Error)
    expect(cached!.message).toContain('cached')
    expect(cached!.message).toContain('clangd spawn failed: ENOENT')
  })

  it('expires after the TTL', () => {
    const cache = new CppInitFailureCache()
    cache.record('scope', 'boom', 1_000)
    expect(cache.cached('scope', 1_000 + CPP_TTL - 1)).not.toBeNull()
    expect(cache.cached('scope', 1_000 + CPP_TTL)).toBeNull()
  })

  it('keeps scopes isolated and clear() wipes one scope', () => {
    const cache = new CppInitFailureCache()
    cache.record('a', 'boom-a', 1_000)
    cache.record('b', 'boom-b', 1_000)
    cache.clear('a')
    expect(cache.cached('a', 1_000 + 1)).toBeNull()
    expect(cache.cached('b', 1_000 + 1)).not.toBeNull()
  })
})

describe('isTransientInitFailure', () => {
  it.each([
    'initialize timed out after 30000ms',
    'LSP request timeout',
    'SSH target is not connected: target-1',
    'connection closed during initialize',
    'Operation aborted'
  ])('treats %j as transient (never cached)', (message) => {
    expect(isTransientInitFailure(new Error(message))).toBe(true)
  })

  it.each([
    'clangd compile commands directory is missing on the execution Host: /cdb',
    'spawn clangd ENOENT',
    'No managed clangd version is active on this Host',
    'Code intelligence scope revision is stale'
  ])('treats %j as deterministic (cached)', (message) => {
    expect(isTransientInitFailure(new Error(message))).toBe(false)
  })
})
