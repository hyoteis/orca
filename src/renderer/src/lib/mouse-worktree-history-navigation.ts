import { useEffect } from 'react'
import { useAppStore } from '@/store'

export type MouseHistoryDirection = 'back' | 'forward'

export function getMouseHistoryDirection(button: number): MouseHistoryDirection | null {
  if (button === 4) {
    return 'forward'
  }
  if (button === 3) {
    return 'back'
  }
  return null
}

export function installMouseWorktreeHistoryNavigation(
  target: Window,
  actions: { back: () => void; forward: () => void }
): () => void {
  const preventNativeNavigation = (event: MouseEvent): void => {
    if (!getMouseHistoryDirection(event.button)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const navigate = (event: MouseEvent): void => {
    const direction = getMouseHistoryDirection(event.button)
    if (!direction) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (direction === 'forward') {
      actions.forward()
    } else {
      actions.back()
    }
  }
  target.addEventListener('mousedown', preventNativeNavigation, true)
  target.addEventListener('mouseup', navigate, true)
  return () => {
    target.removeEventListener('mousedown', preventNativeNavigation, true)
    target.removeEventListener('mouseup', navigate, true)
  }
}

export function useMouseWorktreeHistoryNavigation(): void {
  useEffect(
    () =>
      installMouseWorktreeHistoryNavigation(window, {
        back: () => useAppStore.getState().goBackWorktree(),
        forward: () => useAppStore.getState().goForwardWorktree()
      }),
    []
  )
}
