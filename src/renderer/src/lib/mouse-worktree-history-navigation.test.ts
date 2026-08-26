// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  getMouseHistoryDirection,
  installMouseWorktreeHistoryNavigation
} from './mouse-worktree-history-navigation'

describe('mouse worktree history navigation', () => {
  it('maps the upper side button to forward and the lower button to back', () => {
    expect(getMouseHistoryDirection(4)).toBe('forward')
    expect(getMouseHistoryDirection(3)).toBe('back')
    expect(getMouseHistoryDirection(0)).toBeNull()
  })

  it('navigates once on mouseup and prevents native side-button history', () => {
    const target = new EventTarget() as Window
    const back = vi.fn()
    const forward = vi.fn()
    const cleanup = installMouseWorktreeHistoryNavigation(target, { back, forward })
    const down = new MouseEvent('mousedown', { button: 4, cancelable: true })
    const up = new MouseEvent('mouseup', { button: 4, cancelable: true })

    target.dispatchEvent(down)
    target.dispatchEvent(up)

    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    expect(forward).toHaveBeenCalledOnce()
    expect(back).not.toHaveBeenCalled()
    cleanup()
  })
})
