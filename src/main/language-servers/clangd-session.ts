// clangd protocol session on top of the JSON-RPC client + host-adapter process
// opener. Initialize shape + result mapping live in clangd-protocol.ts, the
// initialize handshake in clangd-session-handshake.ts; this module owns
// lifecycle + the document table. Host-agnostic: the adapter supplies path
// mappers (Orca identity <-> LSP `file:` URI) + the process opener (native
// spawnProcess or WSL wsl.exe). Shutdown: shutdown -> exit -> tree kill.
import { createLspJsonRpcClient, type LspJsonRpcClient } from './lsp-jsonrpc-client'
import { NATIVE_LANGUAGE_SERVER_GRACEFUL_EXIT_MS } from './native-language-server-process'
import {
  answerClangdServerRequest,
  createClangdIndexingTracker,
  createClangdProgressTracker,
  mapClangdDefinitionResult,
  mapClangdDocumentSymbolResult,
  mapClangdHoverResult,
  mapClangdLocationResult
} from './clangd-protocol'
import { performClangdHandshake } from './clangd-session-handshake'
import {
  decodeSemanticTokensFullResult,
  type SemanticTokenLegend
} from './semantic-token-legend-decoder'
import { createNativeHostAdapter } from './native-language-server-adapter'
import type {
  LanguageServerHostAdapter,
  LanguageServerProcessHandle
} from './language-server-host-adapter'
import { lspLanguageForFile } from './clangd-session-language-id'
import type { ClangdSession, ClangdSessionOptions } from './clangd-session-types'
export type { ClangdSession, ClangdSessionOptions } from './clangd-session-types'
export { ClangdPositionEncodingError } from './clangd-session-handshake'

import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentChange,
  LanguageServerDocumentSymbolPayload,
  LanguageServerHoverContent,
  LanguageServerPosition,
  LanguageServerSemanticTokens
} from '../../shared/language-server-navigation-types'

export class ClangdDocumentNotOpenError extends Error {
  constructor(filePath: string) {
    super(`clangd session has no open document: ${filePath}`)
    this.name = 'ClangdDocumentNotOpenError'
  }
}

const SHUTDOWN_TIMEOUT_MS = 5_000

type OpenDocument = {
  uri: string
  version: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Spawns clangd, runs the initialize handshake, and returns a session bound to
 * the process. Rejects — after reaping the child — when the handshake fails or
 * the server does not confirm `positionEncoding: utf-16`.
 */
export async function openClangdSession(options: ClangdSessionOptions): Promise<ClangdSession> {
  const log = (line: string): void => options.onLog?.(line)
  const progress = createClangdProgressTracker()
  const indexing = createClangdIndexingTracker()
  // Host adapter: defaults to native (S1 callers); WSL binds UNC<->guest mappers + wsl.exe spawn.
  const adapter: LanguageServerHostAdapter = options.adapter ?? createNativeHostAdapter()

  let client: LspJsonRpcClient | null = null
  let stopping = false
  let died: Error | null = null
  let serverVersion: string | null = null
  // Server semantic-token legend, captured at initialize (decoded BY NAME — spike §1).
  let semanticLegend: SemanticTokenLegend | null = null

  const documents = new Map<string, OpenDocument>()

  const markDied = (reason: string): void => {
    if (died !== null) {
      return
    }
    died = new Error(`clangd session died: ${reason}`)
    client?.die(reason)
    options.onStatus?.(null)
    options.onIndexing?.(null)
    options.onExit?.(died)
  }

  const processHandle: LanguageServerProcessHandle = adapter.openProcess(
    {
      program: options.program,
      args: options.args,
      cwd: options.cwd ?? options.rootPath,
      env: options.env
    },
    {
      onStdoutChunk: (chunk) => client?.feed(chunk),
      onStderrLine: (line) => log(`[clangd] ${line}`),
      onExit: (error) => {
        if (stopping) {
          options.onExit?.(null)
          return
        }
        markDied(error ? `process exit: ${error.message}` : 'process exited unexpectedly')
      }
    },
    options.spawnImpl
  )

  client = createLspJsonRpcClient((bytes) => processHandle.write(bytes), {
    onServerNotification: handleNotification,
    onServerRequest: (method, params) => answerClangdServerRequest(method, params, log),
    onProtocolError: (error) => {
      log(`[clangd] protocol error: ${error.message}`)
      markDied(`protocol error: ${error.message}`)
      void processHandle.killTree()
    }
  })

  function handleNotification(method: string, params: unknown): void {
    if (method === '$/progress') {
      const status = progress.reduce(params)
      if (status !== undefined) {
        options.onStatus?.(status)
      }
      const indexState = indexing.reduce(params)
      if (indexState !== undefined) {
        options.onIndexing?.(indexState)
      }
      return
    }
    if (method === 'textDocument/publishDiagnostics') {
      // v1 keeps diagnostics only for version alignment — no IPC, no UI (spec §1).
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishDiagnostics params are the wire-deserialized LSP payload; `uri`/`version` are read through optional chaining and typeof-checked before use.
      const p = params as { uri?: string; version?: number | null } | null
      if (p?.uri && typeof p.version === 'number') {
        const doc = documents.get(adapter.lspUriToPath(p.uri))
        if (doc) {
          doc.version = Math.max(doc.version, p.version)
        }
      }
      return
    }
    if (method === 'window/logMessage') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: logMessage params are the wire-deserialized LSP payload; `message` is read through optional chaining for the log line.
      log(`[clangd/log] ${(params as { message?: string } | null)?.message ?? ''}`)
      return
    }
    if (method === 'exit' || method.startsWith('$/')) {
      return // LSP: $/ notifications may be dropped silently.
    }
    log(`[clangd] notification ${method}`)
  }

  async function handshake(): Promise<void> {
    const captured = await performClangdHandshake({
      client: client!,
      rootPath: options.rootPath,
      processId: process.pid,
      pathToLspUri: adapter.pathToLspUri,
      log
    })
    serverVersion = captured.serverVersion
    semanticLegend = captured.semanticLegend
  }

  function documentFor(filePath: string): OpenDocument {
    const key = adapter.normalizeKey(filePath)
    const doc = documents.get(key)
    if (!doc) {
      throw new ClangdDocumentNotOpenError(key)
    }
    return doc
  }

  function positionParams(filePath: string, position: LanguageServerPosition) {
    return {
      textDocument: { uri: documentFor(filePath).uri },
      position: { line: position.line, character: position.character }
    }
  }

  const session: ClangdSession = {
    get serverVersion(): string | null {
      return serverVersion
    },
    get rootPath(): string {
      return options.rootPath
    },
    get died(): Error | null {
      return died
    },
    hasDocument(filePath: string): boolean {
      return documents.has(adapter.normalizeKey(filePath))
    },
    didOpen(filePath: string, text: string): void {
      const key = adapter.normalizeKey(filePath)
      const uri = adapter.pathToLspUri(key)
      documents.set(key, { uri, version: 1 })
      client?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: lspLanguageForFile(key), version: 1, text }
      })
    },
    didChange(
      filePath: string,
      version: number,
      changes: readonly LanguageServerDocumentChange[]
    ): number {
      const doc = documentFor(filePath)
      // LSP requires monotonically increasing versions; the renderer owns the
      // counter, the session clamps replays and out-of-order IPC (spec D4).
      doc.version = Math.max(doc.version + 1, version)
      client?.notify('textDocument/didChange', {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: changes.map((change) => ({
          range: {
            start: { line: change.range.startLine, character: change.range.startCharacter },
            end: { line: change.range.endLine, character: change.range.endCharacter }
          },
          rangeLength: change.rangeLength,
          text: change.text
        }))
      })
      return doc.version
    },
    didClose(filePath: string): void {
      const key = adapter.normalizeKey(filePath)
      const doc = documentFor(filePath)
      documents.delete(key)
      client?.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    },
    async definition(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      const result = await client!.request(
        'textDocument/definition',
        positionParams(filePath, position)
      )
      return mapClangdDefinitionResult(result, adapter.lspUriToPath)
    },
    async references(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      // `includeDeclaration: true` so the declaration site appears in the list
      // (matches VS Code's Shift+F12 default; clangd honors the field).
      const params = {
        ...positionParams(filePath, position),
        context: { includeDeclaration: true }
      }
      const result = await client!.request('textDocument/references', params)
      return mapClangdLocationResult(result, adapter.lspUriToPath)
    },
    async declaration(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      const result = await client!.request(
        'textDocument/declaration',
        positionParams(filePath, position)
      )
      return mapClangdLocationResult(result, adapter.lspUriToPath)
    },
    async hover(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerHoverContent | null> {
      const result = await client!.request('textDocument/hover', positionParams(filePath, position))
      return mapClangdHoverResult(result)
    },
    async semanticTokensFull(filePath: string): Promise<LanguageServerSemanticTokens> {
      if (!semanticLegend) {
        return { tokenTypes: [], tokenModifiers: [], tokens: [] }
      }
      const doc = documentFor(filePath)
      const result = await client!.request('textDocument/semanticTokens/full', {
        textDocument: { uri: doc.uri }
      })
      return decodeSemanticTokensFullResult(result, semanticLegend)
    },
    async documentSymbols(filePath: string): Promise<LanguageServerDocumentSymbolPayload> {
      const doc = documentFor(filePath)
      const result = await client!.request('textDocument/documentSymbol', {
        textDocument: { uri: doc.uri }
      })
      return mapClangdDocumentSymbolResult(result)
    },
    async stop(): Promise<void> {
      if (died !== null || stopping) {
        return
      }
      stopping = true
      try {
        await Promise.race([
          client!.request('shutdown', null, { timeoutMs: SHUTDOWN_TIMEOUT_MS }),
          sleep(SHUTDOWN_TIMEOUT_MS)
        ])
      } catch {
        // Fall through to the exit ladder — a deaf clangd still gets killed.
      }
      client!.notify('exit')
      processHandle.endStdin()
      const exitedFirst = await Promise.race([
        processHandle.exited.then(() => true),
        sleep(NATIVE_LANGUAGE_SERVER_GRACEFUL_EXIT_MS).then(() => false)
      ])
      if (!exitedFirst) {
        await processHandle.killTree()
      }
    }
  }

  try {
    await handshake()
  } catch (error) {
    await session.stop()
    throw error instanceof Error ? error : new Error(String(error))
  }
  return session
}
