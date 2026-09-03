import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'
import { LocalLanguageServerSessionManager } from '../../../language-server/local-language-server-session-manager'
import { ManagedLanguageServerInstaller } from '../../../language-server/managed-language-server-installer'
import { MANAGED_LANGUAGE_SERVER_MANIFEST } from '../../../../shared/managed-language-server-manifest-data'
import { LANGUAGE_SERVER_KINDS } from '../../../../shared/language-server-session'

const Kind = z.enum(LANGUAGE_SERVER_KINDS)

const Params = z.object({
  sessionId: z.string().min(1),
  kind: Kind,
  workspaceRoot: z.string().min(1),
  executionHostId: z.string().optional(),
  scopeId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
  command: z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string())
    })
    .optional(),
  managed: z
    .object({
      tool: Kind,
      version: z.string().optional()
    })
    .optional()
})

/** Relay-Host managed installs live under ~/.orca (the relay is a Node server
 * with no Electron userData). Host-resolved truth (#15): this Host's own
 * trusted manifest governs; clients only ever send manifest ids. */
function getRelayManagedInstaller(): ManagedLanguageServerInstaller {
  relayInstallerSingleton ??= new ManagedLanguageServerInstaller({
    root: join(homedir(), '.orca', 'code-intelligence', 'managed'),
    manifest: MANAGED_LANGUAGE_SERVER_MANIFEST
  })
  return relayInstallerSingleton
}

let relayInstallerSingleton: ManagedLanguageServerInstaller | null = null

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
        // Managed sources resolve on this Host; the client's paths are
        // meaningless here (mixed-version safety: old clients send none).
        let command = params.command
        if (params.managed) {
          const resolved = await getRelayManagedInstaller().resolveActiveCommand(
            params.managed.tool,
            params.managed.version
          )
          if (!resolved) {
            const target = params.managed.version
              ? `${params.managed.tool} ${params.managed.version}`
              : params.managed.tool
            throw new Error(`No managed ${target} version is active on this Runtime Host`)
          }
          command = resolved
        }
        manager.open({
          sessionId: params.sessionId,
          scopeId: params.scopeId ?? 'runtime',
          revision: params.revision ?? 0,
          kind: params.kind,
          workspaceRoot: params.workspaceRoot,
          executionHostId: 'local',
          command,
          members: []
        })
        await done
      } finally {
        ctx.signal?.removeEventListener('abort', abort)
        unregister()
        manager.close(params.sessionId)
      }
    }
  }),
  defineStreamingMethod({
    // Progress/cancellation stream (#15): separate from languageServer.session
    // so old Hosts/Clients degrade to Phase 1 guidance via the capability.
    // ponytail: v1 supports host-direct download only; client-file upload
    // over the binary channel can follow if offline relays need it.
    name: 'languageServer.managedInstall',
    params: z.object({
      tool: Kind,
      version: z.string().optional(),
      route: z.literal('host-download')
    }),
    handler: async (params, ctx, emit) => {
      const result = await getRelayManagedInstaller().install({
        tool: params.tool,
        version: params.version,
        route: { type: params.route },
        signal: ctx.signal ?? undefined,
        onEvent: (event) => emit({ event })
      })
      emit({ result })
    }
  }),
  defineStreamingMethod({
    name: 'languageServer.managedInstallState',
    params: z.object({ tool: Kind }),
    handler: async (params, _ctx, emit) => {
      emit({ state: await getRelayManagedInstaller().state(params.tool) })
    }
  }),
  defineStreamingMethod({
    name: 'languageServer.managedRollback',
    params: z.object({ tool: Kind }),
    handler: async (params, _ctx, emit) => {
      emit({ result: await getRelayManagedInstaller().rollback(params.tool) })
    }
  })
]

