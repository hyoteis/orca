import { ipcMain, type WebContents } from 'electron'
import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  LanguageServerSessionEvent,
  LanguageServerSessionOpenRequest
} from '../../shared/language-server-session'
import type { CodeIntelligenceScopeStore } from '../language-server/code-intelligence-scope-store'
import {
  LocalLanguageServerSessionManager,
  resolveDefaultLocalLanguageServerCommand
} from '../language-server/local-language-server-session-manager'
import {
  buildWindowsLanguageServerCommand,
  SshLanguageServerSessionManager
} from '../ssh/ssh-language-server-session-manager'
import { getSshConnectionManager } from './ssh'
import {
  assertClangdCompileCommandsDirExists,
  localDirectoryExists
} from '../language-server/clangd-compile-commands-dir'
import {
  buildRemoteDirectoryExistsCommand,
  SshSetupConnectionError,
  SshSetupExecQueue
} from '../language-server/code-intelligence-ssh-setup-exec'

type SessionRoute = {
  send: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  close: () => void
}

export function registerLanguageServerSessionHandlers(scopes: CodeIntelligenceScopeStore): void {
  const owners = new Map<string, WebContents>()
  const routes = new Map<string, SessionRoute>()
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
  const localManager = new LocalLanguageServerSessionManager(emit)
  const sshManager = new SshLanguageServerSessionManager(
    emit,
    resolveDefaultLocalLanguageServerCommand
  )
  const closeOwnedSession = (sessionId: string): void => {
    owners.delete(sessionId)
    const route = routes.get(sessionId)
    routes.delete(sessionId)
    route?.close()
  }

  ipcMain.handle(
    'languageServers:open',
    async (event, request: LanguageServerSessionOpenRequest) => {
      const launch = scopes.authorizeSession(request)
      const host = parseExecutionHostId(launch.executionHostId)
      if (!host || host.kind === 'runtime') {
        throw new Error('Runtime language-server sessions must use the Runtime adapter')
      }
      owners.set(request.sessionId, event.sender)
      try {
        if (host.kind === 'ssh') {
          const connectionManager = getSshConnectionManager()
          const connection = connectionManager?.getConnection(host.targetId)
          if (!connection) {
            throw new Error(`SSH target is not connected: ${host.targetId}`)
          }
          const buildCommand =
            connectionManager?.getState(host.targetId)?.remotePlatform === 'win32'
              ? buildWindowsLanguageServerCommand
              : undefined
          const queue = new SshSetupExecQueue(connection)
          await assertClangdCompileCommandsDirExists(launch, async (directory) => {
            const result = await queue.exec(buildRemoteDirectoryExistsCommand(directory))
            // A close without an exit status is a dead transport, not a missing directory.
            if (result.code === null) {
              throw new SshSetupConnectionError('SSH connection was interrupted')
            }
            return result.code === 0
          })
          await sshManager.open(connection, launch, buildCommand)
          routes.set(request.sessionId, {
            send: (bytes) => sshManager.send(request.sessionId, bytes),
            close: () => sshManager.close(request.sessionId)
          })
        } else {
          await assertClangdCompileCommandsDirExists(launch, localDirectoryExists)
          localManager.open(launch)
          routes.set(request.sessionId, {
            send: (bytes) => localManager.send(request.sessionId, bytes),
            close: () => localManager.close(request.sessionId)
          })
        }
      } catch (error) {
        owners.delete(request.sessionId)
        routes.delete(request.sessionId)
        throw error
      }
      event.sender.once('destroyed', () => {
        if (owners.get(request.sessionId) === event.sender) {
          closeOwnedSession(request.sessionId)
        }
      })
      return { sessionId: request.sessionId }
    }
  )
  ipcMain.on(
    'languageServers:write',
    (event, payload: { sessionId: string; bytes: Uint8Array<ArrayBufferLike> }) => {
      if (owners.get(payload.sessionId) === event.sender) {
        routes.get(payload.sessionId)?.send(payload.bytes)
      }
    }
  )
  ipcMain.on('languageServers:close', (event, payload: { sessionId: string }) => {
    if (owners.get(payload.sessionId) === event.sender) {
      closeOwnedSession(payload.sessionId)
    }
  })
}
