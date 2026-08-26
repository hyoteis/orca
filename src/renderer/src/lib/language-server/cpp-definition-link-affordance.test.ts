import { describe, expect, it, vi } from 'vitest'

vi.mock('./cpp-definition-navigation', () => ({
  openCppDefinitionTarget: vi.fn(),
  resolveCppDefinition: vi.fn()
}))
import { isCppDefinitionModifierPressed } from './cpp-definition-link-affordance'

describe('C++ definition link modifier', () => {
  it('uses Command on macOS', () => {
    expect(isCppDefinitionModifierPressed('Macintosh', { ctrlKey: false, metaKey: true })).toBe(
      true
    )
    expect(isCppDefinitionModifierPressed('Macintosh', { ctrlKey: true, metaKey: false })).toBe(
      false
    )
  })

  it('uses Control on Windows and Linux', () => {
    expect(isCppDefinitionModifierPressed('Windows', { ctrlKey: true, metaKey: false })).toBe(true)
    expect(isCppDefinitionModifierPressed('Linux', { ctrlKey: false, metaKey: true })).toBe(false)
  })
})
