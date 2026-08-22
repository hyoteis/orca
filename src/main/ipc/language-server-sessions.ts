import { ipcMain, type WebContents } from 'electron'
import type {
  LanguageServerSessionEvent,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'
import {
  LocalLanguageServerSessionManager,
  resolveDefaultLocalLanguageServerCommand
} from '../language-server/local-language-server-session-manager'
import {
  buildWindowsLanguageServerCommand,
  SshLanguageServerSessionManager
} from '../ssh/ssh-language-server-session-manager'
import { getSshConnectionManager } from './ssh'

export function registerLanguageServerSessionHandlers(): void {
  const owners = new Map<string, WebContents>()
  const routes = new Map<string, 'local' | 'ssh'>()
  const emit = (sessionId: string, event: LanguageServerSessionEvent): void => {
    const owner = owners.get(sessionId)
    if (!owner?.isDestroyed()) {
      owner?.send('languageServers:event', { sessionId, event })
    }
    if (
      event.type === 'status' &&
      (event.status.type === 'exit' || event.status.type === 'closed')
    ) {
      owners.delete(sessionId)
      routes.delete(sessionId)
    }
  }
  const manager = new LocalLanguageServerSessionManager(emit)
  const sshManager = new SshLanguageServerSessionManager(
    emit,
    resolveDefaultLocalLanguageServerCommand
  )
  ipcMain.handle(
    'languageServers:open',
    async (event, request: LanguageServerSessionOpenRequest) => {
      owners.set(request.sessionId, event.sender)
      try {
        if (request.executionHostId?.startsWith('ssh:')) {
          const targetId = request.executionHostId.slice('ssh:'.length)
          const connectionManager = getSshConnectionManager()
          const connection = connectionManager?.getConnection(targetId)
          if (!connection) {
            throw new Error(`SSH target is not connected: ${targetId}`)
          }
          routes.set(request.sessionId, 'ssh')
          const buildCommand =
            connectionManager?.getState(targetId)?.remotePlatform === 'win32'
              ? buildWindowsLanguageServerCommand
              : undefined
          await sshManager.open(connection, request, buildCommand)
        } else {
          routes.set(request.sessionId, 'local')
          manager.open(request)
        }
      } catch (error) {
        owners.delete(request.sessionId)
        routes.delete(request.sessionId)
        throw error
      }
      event.sender.once('destroyed', () => {
        if (owners.get(request.sessionId) === event.sender) {
          owners.delete(request.sessionId)
          const route = routes.get(request.sessionId)
          routes.delete(request.sessionId)
          if (route === 'ssh') {
            sshManager.close(request.sessionId)
          } else {
            manager.close(request.sessionId)
          }
        }
      })
      return { sessionId: request.sessionId }
    }
  )
  ipcMain.on(
    'languageServers:write',
    (event, payload: { sessionId: string; bytes: Uint8Array<ArrayBufferLike> }) => {
      if (owners.get(payload.sessionId) === event.sender) {
        if (routes.get(payload.sessionId) === 'ssh') {
          sshManager.send(payload.sessionId, payload.bytes)
        } else {
          manager.send(payload.sessionId, payload.bytes)
        }
      }
    }
  )
  ipcMain.on('languageServers:close', (event, payload: { sessionId: string }) => {
    if (owners.get(payload.sessionId) !== event.sender) {
      return
    }
    owners.delete(payload.sessionId)
    const route = routes.get(payload.sessionId)
    routes.delete(payload.sessionId)
    if (route === 'ssh') {
      sshManager.close(payload.sessionId)
    } else {
      manager.close(payload.sessionId)
    }
  })
}
