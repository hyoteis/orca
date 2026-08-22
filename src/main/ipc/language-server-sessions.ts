import { ipcMain, type WebContents } from 'electron'
import type { LanguageServerSessionOpenRequest } from '../../shared/language-server-session'
import { LocalLanguageServerSessionManager } from '../language-server/local-language-server-session-manager'

export function registerLanguageServerSessionHandlers(): void {
  const owners = new Map<string, WebContents>()
  const manager = new LocalLanguageServerSessionManager((sessionId, event) => {
    const owner = owners.get(sessionId)
    if (!owner?.isDestroyed()) {
      owner?.send('languageServers:event', { sessionId, event })
    }
    if (
      event.type === 'status' &&
      (event.status.type === 'exit' || event.status.type === 'closed')
    ) {
      owners.delete(sessionId)
    }
  })
  ipcMain.handle('languageServers:open', (event, request: LanguageServerSessionOpenRequest) => {
    owners.set(request.sessionId, event.sender)
    try {
      manager.open(request)
    } catch (error) {
      owners.delete(request.sessionId)
      throw error
    }
    event.sender.once('destroyed', () => {
      if (owners.get(request.sessionId) === event.sender) {
        owners.delete(request.sessionId)
        manager.close(request.sessionId)
      }
    })
    return { sessionId: request.sessionId }
  })
  ipcMain.on(
    'languageServers:write',
    (event, payload: { sessionId: string; bytes: Uint8Array<ArrayBufferLike> }) => {
      if (owners.get(payload.sessionId) === event.sender) {
        manager.send(payload.sessionId, payload.bytes)
      }
    }
  )
  ipcMain.on('languageServers:close', (event, payload: { sessionId: string }) => {
    if (owners.get(payload.sessionId) !== event.sender) {
      return
    }
    owners.delete(payload.sessionId)
    manager.close(payload.sessionId)
  })
}
