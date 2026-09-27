// Stdout lane for one relay LSP session: turns clangd's stdout byte stream into
// budget-sliced `lsp.data` frames without ever dropping a slice. Extracted from
// lsp-handler.ts when it exceeded the max-lines gate; owns the whole pause/
// resume discipline (credit window + producer frame budget) so the handler
// keeps only the spawn/kill/write wiring.
//
// Why slicing to the LIVE budget: the producer lane drops any frame larger than
// the client's current `producerFrameCapacity` (a 64KB-HWM connector pipe gives
// ≈48KB), and a hole in the LSP byte stream is fatal — the client's
// Content-Length framer cannot resynchronize. Base64 grows 4/3, so a raw slice
// is budget*3/4.
import type { LspCreditWindow } from './lsp-credit-window'

/** Structural seam — the relay dispatcher surface this lane needs. */
export type LspStdoutLaneDispatcher = {
  producerDataBudget(method: string, params: Record<string, unknown>, clientId?: number): number
  publishProducerNotification(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: { logDrop?: boolean }
  ): boolean
  onClientCapacity(clientId: number, listener: () => void): (() => void) | null
}

/** Session surface the lane drives (ManagedLspSession satisfies it structurally). */
export type LspStdoutLaneSession = {
  sessionId: string
  clientId: number
  exited: boolean
  detached: boolean
  credit: LspCreditWindow
  stdoutFramesSent: number
  child: { stdout?: { pause(): void; resume(): void } | null }
}

/** Upper bound on one lsp.data frame's raw bytes (base64 grows 4/3). */
const LSP_DATA_CHUNK_BYTES = 256 * 1024
/** Smallest raw slice worth a frame — below this budget the pipe pauses instead. */
const LSP_DATA_MIN_SLICE_BYTES = 4 * 1024
/** Slack for envelope drift (seq digit growth) beyond the data:'' estimate. */
const LSP_DATA_ENVELOPE_SLACK_BYTES = 64

export class LspStdoutLane {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private creditPaused = false
  private capacityPaused = false
  private readonly unsubCapacity: (() => void) | null

  constructor(
    private readonly dispatcher: LspStdoutLaneDispatcher,
    private readonly session: LspStdoutLaneSession
  ) {
    this.unsubCapacity =
      dispatcher.onClientCapacity(session.clientId, () => {
        if (session.exited || session.detached || !this.capacityPaused) {
          return
        }
        this.capacityPaused = false
        if (!this.creditPaused) {
          this.resumeAndFlush()
        }
      }) ?? null
  }

  handleChunk(chunk: Buffer): void {
    const session = this.session
    if (session.exited || session.detached) {
      return
    }
    // Merge anything held earlier so ordering survives across pause/resume.
    const stream: Buffer<ArrayBufferLike> =
      this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    // Credit backpressure: window exhausted; the client's `lsp.ack` reopens it.
    if (session.credit.shouldPause()) {
      this.pending = stream
      this.pauseForCredit()
      return
    }
    if (!this.dispatch(stream)) {
      this.capacityPaused = true
      session.child.stdout?.pause()
    }
  }

  /** Credit window reopened (lsp.ack) — flush and resume unless capacity-starved. */
  creditReopened(): void {
    if (!this.creditPaused) {
      return
    }
    this.creditPaused = false
    if (!this.capacityPaused) {
      this.resumeAndFlush()
    }
  }

  dispose(): void {
    this.unsubCapacity?.()
  }

  /** Publish lsp.data frames for `buffer`, each sliced to the client's CURRENT
   *  producer frame budget. Returns true when fully sent; on a starved budget
   *  the unsent tail is parked in `pending` (never dropped). */
  private dispatch(buffer: Buffer): boolean {
    const session = this.session
    for (let offset = 0; offset < buffer.length;) {
      // Wide seq placeholder: the estimate must also cover later, longer seqs.
      const budget = this.dispatcher.producerDataBudget(
        'lsp.data',
        { sessionId: session.sessionId, seq: 999999999 },
        session.clientId
      )
      const rawBudget = Math.floor(((budget - LSP_DATA_ENVELOPE_SLACK_BYTES) * 3) / 4)
      if (rawBudget < LSP_DATA_MIN_SLICE_BYTES) {
        this.pending = buffer.subarray(offset)
        return false
      }
      const sliceBytes = Math.min(rawBudget, LSP_DATA_CHUNK_BYTES, buffer.length - offset)
      const seq = session.credit.nextOutboundSeq()
      const published = this.dispatcher.publishProducerNotification(
        session.clientId,
        'lsp.data',
        {
          sessionId: session.sessionId,
          seq,
          data: buffer.subarray(offset, offset + sliceBytes).toString('base64')
        },
        { logDrop: false }
      )
      session.credit.recordSent()
      session.stdoutFramesSent += 1
      if (!published) {
        // Client closed mid-slice — the consumer is gone, so there is no stream
        // left to protect; stop pacing (detach semantics, slice dropped).
        return true
      }
      offset += sliceBytes
      // Credit window may have closed mid-burst: park the tail for the ack path.
      if (session.credit.shouldPause() && offset < buffer.length) {
        this.pending = buffer.subarray(offset)
        this.pauseForCredit()
        return true
      }
    }
    return true
  }

  private pauseForCredit(): void {
    if (!this.creditPaused) {
      this.creditPaused = true
    }
    this.session.child.stdout?.pause()
  }

  /** Drain `pending` under the reopened budget, then resume the pipe. A
   *  still-starved budget re-pauses and waits for the next capacity signal. */
  private resumeAndFlush(): void {
    const session = this.session
    if (session.exited || session.detached) {
      return
    }
    if (this.pending.length > 0) {
      const held = this.pending
      this.pending = Buffer.alloc(0)
      if (!this.dispatch(held)) {
        this.capacityPaused = true
        return // pipe stays paused
      }
    }
    session.child.stdout?.resume()
  }
}
