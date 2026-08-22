import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'

export type RpcDispatchStreamingOptions = {
  connectionId?: string
  signal?: AbortSignal
  clientId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  pairing?: PairingRpcContext
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  registerRawBinaryHandler?: (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => () => void
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
}
