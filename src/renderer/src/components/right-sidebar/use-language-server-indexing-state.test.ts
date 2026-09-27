// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetLanguageServerStatusForTests,
  setLanguageServerIndexing
} from '@/components/editor/lsp-navigation/language-server-status-store'
import { useLanguageServerIndexingState } from './use-language-server-indexing-state'

let container: HTMLElement | null = null
let root: Root | null = null
let latest: ReturnType<typeof useLanguageServerIndexingState> | null | undefined

function HookProbe(props: { sessionKey: string | null }): null {
  latest = useLanguageServerIndexingState(props.sessionKey)
  return null
}

function renderProbe(sessionKey: string | null): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  root.render(createElement(HookProbe, { sessionKey }))
}

beforeEach(() => {
  resetLanguageServerStatusForTests()
  latest = undefined
})

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
})

describe('useLanguageServerIndexingState (spec-b B2)', () => {
  it('answers null while no entry exists for the session', async () => {
    renderProbe('wt-1')
    await act(async () => {})
    expect(latest).toBeNull()
  })

  it('answers null for a null session key even when other sessions index', async () => {
    renderProbe(null)
    await act(async () => {
      setLanguageServerIndexing('wt-1', { active: true, percentage: 5 })
    })
    expect(latest).toBeNull()
  })

  it('tracks the live entry for its session and clears on inactive', async () => {
    renderProbe('wt-1')
    await act(async () => {
      setLanguageServerIndexing('wt-1', { active: true, percentage: 5 })
    })
    expect(latest).toEqual({ active: true, percentage: 5 })

    await act(async () => {
      setLanguageServerIndexing('wt-1', { active: true, percentage: 60 })
    })
    expect(latest).toEqual({ active: true, percentage: 60 })

    await act(async () => {
      setLanguageServerIndexing('wt-1', { active: false })
    })
    expect(latest).toBeNull()
  })

  it('ignores entries of other sessions', async () => {
    renderProbe('wt-1')
    await act(async () => {
      setLanguageServerIndexing('wt-2', { active: true, percentage: 5 })
    })
    expect(latest).toBeNull()
  })
})
