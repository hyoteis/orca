// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguageServerStatusEvent } from './language-server-status-subscriber'
import {
  getLanguageServerStatus,
  resetLanguageServerStatusForTests,
  setLanguageServerIndexing,
  subscribeLanguageServerStatus
} from './language-server-status-store'

beforeEach(() => {
  resetLanguageServerStatusForTests()
})

describe('setLanguageServerIndexing (spec-b B2)', () => {
  it('sets an active entry with its percentage', () => {
    setLanguageServerIndexing('wt-1', { active: true, percentage: 42 })
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toEqual({
      active: true,
      percentage: 42
    })
  })

  it('keeps an active entry without a percentage', () => {
    setLanguageServerIndexing('wt-1', { active: true })
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toEqual({ active: true })
  })

  it('deletes the entry when indexing goes inactive', () => {
    setLanguageServerIndexing('wt-1', { active: true, percentage: 10 })
    setLanguageServerIndexing('wt-1', { active: false })
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toBeUndefined()
  })

  it('treats null like inactive', () => {
    setLanguageServerIndexing('wt-1', { active: true })
    setLanguageServerIndexing('wt-1', null)
    expect(getLanguageServerStatus().indexingBySession).toEqual({})
  })

  it('is a no-op (no notify) for inactive without an existing entry', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLanguageServerStatus(listener)
    setLanguageServerIndexing('wt-absent', { active: false })
    setLanguageServerIndexing('wt-absent', null)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not notify for a repeated identical active entry', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLanguageServerStatus(listener)
    setLanguageServerIndexing('wt-1', { active: true, percentage: 7 })
    setLanguageServerIndexing('wt-1', { active: true, percentage: 7 })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('notifies and replaces the entry when the percentage advances', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLanguageServerStatus(listener)
    setLanguageServerIndexing('wt-1', { active: true, percentage: 7 })
    setLanguageServerIndexing('wt-1', { active: true, percentage: 8 })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toEqual({
      active: true,
      percentage: 8
    })
    unsubscribe()
  })

  it('keeps sessions isolated in one record', () => {
    setLanguageServerIndexing('wt-1', { active: true, percentage: 1 })
    setLanguageServerIndexing('wt-2', { active: true, percentage: 2 })
    setLanguageServerIndexing('wt-1', { active: false })
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toBeUndefined()
    expect(getLanguageServerStatus().indexingBySession['wt-2']).toEqual({
      active: true,
      percentage: 2
    })
  })

  it('leaves progress/degraded untouched', () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing' })
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'install clangd 12+' })
    setLanguageServerIndexing('wt-1', { active: true })
    const status = getLanguageServerStatus()
    expect(status.progress).toBe('clangd: indexing')
    expect(status.degraded).toBe('install clangd 12+')
  })

  it('keeps the entry reference stable across unrelated notifications', () => {
    setLanguageServerIndexing('wt-1', { active: true, percentage: 5 })
    const before = getLanguageServerStatus().indexingBySession['wt-1']
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing' })
    expect(getLanguageServerStatus().indexingBySession['wt-1']).toBe(before)
  })
})

describe('applyLanguageServerStatusEvent — indexing wiring', () => {
  it('routes active/inactive indexing events into the per-session store', () => {
    applyLanguageServerStatusEvent({
      kind: 'indexing',
      sessionKey: 'wt-9',
      active: true,
      percentage: 33
    })
    expect(getLanguageServerStatus().indexingBySession['wt-9']).toEqual({
      active: true,
      percentage: 33
    })

    applyLanguageServerStatusEvent({ kind: 'indexing', sessionKey: 'wt-9', active: false })
    expect(getLanguageServerStatus().indexingBySession['wt-9']).toBeUndefined()
  })
})
