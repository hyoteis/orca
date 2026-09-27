// Semantic IPC payloads for the editor language-server surface (spec D2/D3:
// the renderer never sees an LSP message). Coordinates are 0-based line/
// character pairs in the negotiated LSP basis (UTF-16); the ±1 Monaco
// conversion lives in the renderer providers only.

/** 0-based line/character, UTF-16 code units (matches Monaco after ±1). */
export type LanguageServerPosition = {
  line: number
  character: number
}

/** 0-based, end-exclusive-in-practice range (LSP semantics). */
export type LanguageServerRange = {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

/** One incremental edit, translated from the model change event as-is. */
export type LanguageServerDocumentChange = {
  range: LanguageServerRange
  rangeLength?: number
  text: string
}

export type LanguageServerDefinitionLocation = {
  path: string
  range: LanguageServerRange
}

/** Semantic navigation target; same shape as definition (references/declaration reuse it). */
export type LanguageServerNavigationLocation = LanguageServerDefinitionLocation

export type LanguageServerHoverContent = {
  kind: 'markdown' | 'plaintext'
  value: string
}

export type LanguageServerDocumentResult =
  | { ok: true; version?: number }
  | { ok: false; error: string }

export type LanguageServerDefinitionResult =
  | { ok: true; locations: LanguageServerDefinitionLocation[] }
  | { ok: false; error: string; locations: [] }

/** References (Shift+F12): a list of navigation targets, same shape as definition. */
export type LanguageServerReferencesResult =
  | { ok: true; locations: LanguageServerNavigationLocation[] }
  | { ok: false; error: string; locations: [] }

/** Declaration: a list of targets (LSP allows single|[]|null; normalized to a list like definition). */
export type LanguageServerDeclarationResult =
  | { ok: true; locations: LanguageServerNavigationLocation[] }
  | { ok: false; error: string; locations: [] }

export type LanguageServerHoverResult =
  | { ok: true; hover: LanguageServerHoverContent | null }
  | { ok: false; error: string; hover: null }

// ---------------------------------------------------------------------------
// Outline symbols (spec-b B1): mirror types for textDocument/documentSymbol.
// The main process structurally thin-copies the clangd result into these; the
// renderer normalizes to tree/flat rows (B2). LSP SymbolKind is a local
// constant union — the vscode-languageserver-protocol package stays out.
// ---------------------------------------------------------------------------

/** LSP SymbolKind (1..26, value-compatible). */
export type LanguageServerSymbolKind =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26

export const LANGUAGE_SERVER_SYMBOL_KIND = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26
} as const

/** 0-based line/character span of a symbol (same basis as LanguageServerRange). */
export type LanguageServerSymbolRange = {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

/** Hierarchical DocumentSymbol node (hierarchicalDocumentSymbolSupport: true). */
export type LanguageServerDocumentSymbolNode = {
  name: string
  kind: LanguageServerSymbolKind
  range: LanguageServerSymbolRange
  selectionRange: LanguageServerSymbolRange
  children: LanguageServerDocumentSymbolNode[]
}

/** Flat SymbolInformation item (location.range collapsed to `range`). */
export type LanguageServerSymbolInformationItem = {
  name: string
  kind: LanguageServerSymbolKind
  range: LanguageServerSymbolRange
  containerName?: string
}

/** Mirror of the two legal documentSymbol result shapes; empty-vs-null lives in the result type. */
export type LanguageServerDocumentSymbolPayload =
  | { kind: 'hierarchical'; roots: LanguageServerDocumentSymbolNode[] }
  | { kind: 'flat'; items: LanguageServerSymbolInformationItem[] }

/** IPC result: ok+empty = truly empty file; !ok+null = session dead / request failed. */
export type LanguageServerDocumentSymbolResult =
  | { ok: true; symbols: LanguageServerDocumentSymbolPayload; sessionKey: string }
  | { ok: false; error: string; symbols: null; sessionKey: null }

/**
 * Pushed from main to renderer. The status surface is a small discriminated
 * union: `progress` is the transient `$/progress` projection (null clears),
 * `degraded` is a persistent hint (no clangd / version too low; null clears),
 * `toast` is a one-shot notification (LRU eviction) the renderer surfaces via sonner.
 */
export type LanguageServerStatusEvent =
  | { kind: 'progress'; text: string | null }
  | { kind: 'degraded'; message: string | null }
  | { kind: 'toast'; message: string }
  | { kind: 'indexing'; sessionKey: string; active: boolean; percentage?: number }

export const LANGUAGE_SERVERS_STATUS_CHANNEL = 'languageServers:status'

/**
 * One decoded semantic token. clangd's legend does NOT match LSP standard names
 * (spike findings §1), so the main process decodes the server-returned relative
 * 5-tuple BY NAME into this shape for IPC; the renderer re-encodes by name.
 * `line`/`char`/`length` are the LSP relative 5-tuple fields (delta line, delta
 * start char, length — same basis Monaco expects, NO 0/1-based conversion).
 * `type` is the decoded token-type NAME (e.g. 'function', 'variable', or a
 * clangd self-invented name like 'unknown'/'bracket'). `modifiers` are the
 * decoded modifier NAMES. `skip` is true when the type name is unknown to the
 * renderer's legend — the lexical (Monarch) layer then colors the identifier.
 */
export type LanguageServerSemanticToken = {
  line: number
  char: number
  length: number
  type: string
  modifiers: string[]
  /** True when the type name is unknown to the renderer's legend — the lexical (Monarch) layer then colors the identifier. Absent = false. */
  skip?: boolean
}

export type LanguageServerSemanticTokens = {
  /** Decoded legend BY NAME so the renderer never hardcodes clangd indices. */
  tokenTypes: string[]
  tokenModifiers: string[]
  tokens: LanguageServerSemanticToken[]
}

export type LanguageServerSemanticTokensResult =
  | { ok: true; tokens: LanguageServerSemanticTokens }
  | { ok: false; error: string; tokens: null }
