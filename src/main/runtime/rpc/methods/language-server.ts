import { z } from 'zod'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'
import { LocalLanguageServerSessionManager } from '../../../language-server/local-language-server-session-manager'

const Params = z
  .object({
    sessionId: z.string().min(1),
    kind: z.enum(['basedpyright', 'pyright', 'clangd']),
    workspaceRoot: z.string().min(1),
    executionHostId: z.string().optional()
  })
  .strict()
export const LANGUAGE_SERVER_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'languageServer.session',
    params: Params,
    handler: async (params, ctx, emit) => {
      if (!ctx.sendBinary || !ctx.registerRawBinaryHandler) {
        throw new Error('Language server session requires a dedicated binary transport')
      }
      let settle: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      const manager = new LocalLanguageServerSessionManager((_id, event) => {
        if (event.type === 'stdout') {
          ctx.sendBinary?.(event.bytes)
          return
        }
        emit({ status: event.status })
        if (event.status.type === 'exit' || event.status.type === 'closed') {
          settle()
        }
      })
      const unregister = ctx.registerRawBinaryHandler((bytes) =>
        manager.send(params.sessionId, bytes)
      )
      const abort = () => {
        manager.close(params.sessionId)
        settle()
      }
      ctx.signal?.addEventListener('abort', abort, { once: true })
      try {
        manager.open({
          sessionId: params.sessionId,
          kind: params.kind,
          workspaceRoot: params.workspaceRoot
        })
        await done
      } finally {
        ctx.signal?.removeEventListener('abort', abort)
        unregister()
        manager.close(params.sessionId)
      }
    }
  })
]
