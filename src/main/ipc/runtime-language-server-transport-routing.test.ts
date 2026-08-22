import { describe, expect, it } from 'vitest'
import { shouldKeepDedicatedSubscriptionSocket } from './runtime-environment-transport-routing'
describe('LSP Runtime transport routing', () => {
  it('keeps language-server streams off shared control and terminal sockets', () => {
    expect(shouldKeepDedicatedSubscriptionSocket('languageServer.session')).toBe(true)
    expect(shouldKeepDedicatedSubscriptionSocket('files.watch')).toBe(false)
  })
})
