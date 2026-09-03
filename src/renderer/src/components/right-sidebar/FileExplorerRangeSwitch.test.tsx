import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { FileExplorerRangeSwitch } from './FileExplorerRangeSwitch'

type ReactElementLike = ReactElement & {
  props: Record<string, unknown> & { children?: unknown }
}

function findElementByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElementLike
    if (element.props['aria-label'] === ariaLabel) {
      return element
    }
    const children = element.props.children
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findElementByAriaLabel(child, ariaLabel)
        if (found) {
          return found
        }
      }
    } else if (children && typeof children === 'object') {
      const found = findElementByAriaLabel(children, ariaLabel)
      if (found) {
        return found
      }
    }
  }
  return null as unknown as ReactElementLike
}

function findElementByValue(node: unknown, value: string): ReactElementLike {
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElementLike
    if (element.props.value === value) {
      return element
    }
    const children = element.props.children
    const candidates = Array.isArray(children) ? children : [children]
    for (const child of candidates) {
      if (child && typeof child === 'object') {
        const found = findElementByValue(child, value)
        if (found) {
          return found
        }
      }
    }
  }
  return null as unknown as ReactElementLike
}

describe('FileExplorerRangeSwitch', () => {
  it('defaults to the worktree range', () => {
    const element = FileExplorerRangeSwitch({
      range: 'worktree',
      scopeRangeUnavailable: false,
      onSelectRange: vi.fn()
    })

    const switchRoot = findElementByAriaLabel(element, 'Explorer search range')
    expect(switchRoot.props.value).toBe('worktree')
    expect(JSON.stringify(switchRoot.props.children)).toContain('◆ Scope')
    expect(JSON.stringify(switchRoot.props.children)).toContain('Worktree')
  })

  it('selects the scope range through the switch callback', () => {
    const onSelectRange = vi.fn()
    const element = FileExplorerRangeSwitch({
      range: 'worktree',
      scopeRangeUnavailable: false,
      onSelectRange
    })

    const switchRoot = findElementByAriaLabel(element, 'Explorer search range')
    ;(switchRoot.props.onValueChange as (value: string) => void)('scope')

    expect(onSelectRange).toHaveBeenCalledWith('scope')
  })

  it('disables the scope side with guidance when no local members exist', () => {
    const element = FileExplorerRangeSwitch({
      range: 'worktree',
      scopeRangeUnavailable: true,
      onSelectRange: vi.fn()
    })

    const scopeItem = findElementByValue(element, 'scope')
    expect(scopeItem.props.disabled).toBe(true)
    expect(scopeItem.props.title).toBe('No Code scope members to search yet')
  })
})
