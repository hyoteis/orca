// Initialize handshake for the clangd session: sends the spike-verified
// initialize params, refuses a non-utf-16 positionEncoding, captures the
// server's semantic-token legend + version, and notifies `initialized`.
// Extracted from clangd-session.ts to keep that module under its line budget.
import { buildClangdInitializeParams } from './clangd-protocol'
import type { LspJsonRpcClient } from './lsp-jsonrpc-client'
import type { SemanticTokenLegend } from './semantic-token-legend-decoder'

const INITIALIZE_TIMEOUT_MS = 15_000

export class ClangdPositionEncodingError extends Error {
  constructor(actual: string | undefined) {
    super(
      `clangd advertised positionEncoding '${actual ?? 'none'}' (not utf-16); refusing the session — column math would corrupt on non-ASCII lines`
    )
    this.name = 'ClangdPositionEncodingError'
  }
}

/**
 * Runs the initialize handshake. Throws — leaving the caller to reap the
 * child — when the handshake fails or the server does not confirm
 * `positionEncoding: utf-16`.
 */
export async function performClangdHandshake(args: {
  client: LspJsonRpcClient
  rootPath: string
  processId: number
  /** Host-local path -> LSP URI mapper (native drive form or WSL guest form). */
  pathToLspUri: (filePath: string) => string
  log: (line: string) => void
}): Promise<{ serverVersion: string | null; semanticLegend: SemanticTokenLegend | null }> {
  const { client, rootPath, processId, pathToLspUri, log } = args
  const response = await client.request(
    'initialize',
    buildClangdInitializeParams(rootPath, processId, pathToLspUri),
    { timeoutMs: INITIALIZE_TIMEOUT_MS }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the initialize result is the wire-deserialized LSP InitializeResult; `positionEncoding` is verified against utf-16 (throws otherwise), `referencesProvider`/`declarationProvider`/`semanticTokensProvider.legend` are read through typeof/optional-chaining guards before use, and `serverInfo.version` is read through optional chaining.
  const result = response as {
    capabilities?: {
      positionEncoding?: string
      referencesProvider?: unknown
      declarationProvider?: unknown
      semanticTokensProvider?: { legend?: SemanticTokenLegend } | boolean
    }
    serverInfo?: { version?: string }
  } | null

  const encoding = result?.capabilities?.positionEncoding
  // LSP 3.17 default is utf-16 when the server omits positionEncoding; clangd 18
  // (pre-negotiation) omits it yet answers in UTF-16 units (verified 18.1.3).
  // Only an EXPLICIT non-utf-16 encoding would corrupt columns — refuse that.
  if (encoding !== undefined && encoding !== 'utf-16') {
    throw new ClangdPositionEncodingError(encoding)
  }
  // Capture the server's semantic-token legend for by-name decoding (S5 / spike
  // findings §1). The provider may be a boolean (no legend) — clangd always
  // returns the legend object.
  const semProvider = result?.capabilities?.semanticTokensProvider
  const semanticLegend =
    semProvider && typeof semProvider === 'object' && semProvider.legend ? semProvider.legend : null
  // Verify the server echoes the S4 capabilities (S4 criterion). clangd
  // always advertises both; absence means a non-conformant build — warn so
  // the request's failure is explainable, but don't refuse (the request
  // itself is the authoritative check; spec §9 residual risk).
  const caps = result?.capabilities
  if (caps && (!caps.referencesProvider || !caps.declarationProvider)) {
    log('[clangd] server did not advertise references/declaration capability')
  }
  client.notify('initialized', {})
  return { serverVersion: result?.serverInfo?.version ?? null, semanticLegend }
}
