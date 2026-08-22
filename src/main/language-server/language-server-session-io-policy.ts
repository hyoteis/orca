const DEFAULT_MAX_PENDING_INPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024

export function acceptsLanguageServerInput(
  pendingBytes: number,
  incomingBytes: number,
  maxBytes = DEFAULT_MAX_PENDING_INPUT_BYTES
): boolean {
  return pendingBytes + incomingBytes <= maxBytes
}

export function retainLanguageServerStderr(
  retainedBytes: number,
  chunk: Buffer,
  maxBytes = DEFAULT_MAX_STDERR_BYTES
): { accepted: Buffer; retainedBytes: number; truncated: boolean } {
  const accepted = chunk.subarray(0, Math.max(0, maxBytes - retainedBytes))
  const nextRetainedBytes = retainedBytes + accepted.byteLength
  return {
    accepted,
    retainedBytes: nextRetainedBytes,
    truncated: accepted.byteLength < chunk.byteLength || nextRetainedBytes === maxBytes
  }
}
