// Pure clangd-protocol pieces of the session: initialize parameter shape,
// server-request answers, the $/progress -> status reducer and result
// mapping. Kept free of process/transport concerns so they stay unit-testable
// and the session module stays under its line budget.
import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentSymbolNode,
  LanguageServerDocumentSymbolPayload,
  LanguageServerHoverContent,
  LanguageServerSymbolInformationItem,
  LanguageServerSymbolKind,
  LanguageServerSymbolRange
} from '../../shared/language-server-navigation-types'
import {
  SEMANTIC_TOKEN_CLIENT_MODIFIERS,
  SEMANTIC_TOKEN_CLIENT_TYPES
} from './semantic-token-legend-decoder'

/** The initialize params verified against clangd 23 in the spike (findings §5). */
export function buildClangdInitializeParams(
  rootPath: string,
  processId: number,
  /** Host-local path -> LSP URI mapper (native drive form or WSL guest form). */
  pathToLspUri: (filePath: string) => string
): unknown {
  const rootUri = pathToLspUri(rootPath)
  const rootName = rootPath.split(/[\\/]/).pop() ?? rootPath
  return {
    processId,
    clientInfo: { name: 'orca', version: 'editor-navigation' },
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: rootName }],
    capabilities: {
      // clangd defaults to UTF-8 offsets unless negotiated otherwise, while
      // Monaco columns are UTF-16 code units — pin the shared basis (§1).
      general: { positionEncodings: ['utf-16'] },
      window: { workDoneProgress: true },
      workspace: { workspaceFolders: false, configuration: false },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: false
        },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        definition: { dynamicRegistration: false, linkSupport: false },
        declaration: { dynamicRegistration: false, linkSupport: false },
        references: { dynamicRegistration: false },
        // Hierarchical symbols (spec-b B1): flat SymbolInformation names carry
        // ::-qualified containers that flatten the tree; hierarchical results
        // keep class/namespace nodes (mirrors main's declaration).
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        // Semantic coloring (S5 / spike findings §1): the client declares the
        // normalized FULL token set; the server returns its OWN legend which
        // is decoded BY NAME (not hardcoded standard-enum indices — clangd's
        // legend differs: method not function.member, 24 types incl.
        // unknown/bracket/label, 19 modifiers incl. self-invented scopes).
        // full:true / range:false — only whole-document tokens are used.
        semanticTokens: {
          dynamicRegistration: false,
          requests: { range: false, full: true },
          tokenTypes: [...SEMANTIC_TOKEN_CLIENT_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_CLIENT_MODIFIERS],
          formats: ['relative']
        }
      }
    }
  }
}

/**
 * Server->client request answers. These MUST be answered or clangd stalls
 * (spike findings §5): workDoneProgress/create gates every $/progress
 * notification, workspace/configuration expects one result per item.
 */
export function answerClangdServerRequest(
  method: string,
  params: unknown,
  log: (line: string) => void
): unknown {
  if (method === 'workspace/configuration') {
    // No clangd config file support in v1: answer null per item.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: workspace/configuration params are the wire-deserialized LSP payload; only `items` is read and each is answered null, so an unknown shape degrades to an empty list.
    const items = (params as { items?: unknown[] } | null)?.items ?? []
    return items.map(() => null)
  }
  if (method === 'window/workDoneProgress/create') {
    return null
  }
  log(`[clangd] server request ${method} -> null`)
  return null
}

export type ClangdProgressTracker = {
  /** Projected status text, null to clear, undefined when the event carries no projection. */
  reduce(params: unknown): string | null | undefined
}

/** Maps `$/progress` notifications to a single status-line projection. */
export function createClangdProgressTracker(): ClangdProgressTracker {
  // token -> title, so reports after `begin` stay named.
  const titles = new Map<string | number, string>()
  return {
    reduce(params: unknown): string | null | undefined {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: $/progress params are the wire-deserialized LSP payload; every field is read through optional chaining, so an unknown shape yields undefined.
      const p = params as {
        token?: string | number
        value?: { kind?: string; title?: string; message?: string; percentage?: number }
      } | null
      const token = p?.token
      if (token === undefined) {
        return undefined
      }
      const value = p?.value
      if (value?.kind === 'begin' && value.title) {
        titles.set(token, value.title)
      }
      if (value?.kind === 'end') {
        titles.delete(token)
        return titles.size > 0 ? 'clangd working' : null
      }
      const title = titles.get(token) ?? 'clangd'
      const pct = typeof value?.percentage === 'number' ? ` ${Math.floor(value.percentage)}%` : ''
      const detail = value?.message ? ` — ${value.message}` : ''
      return `clangd: ${title}${pct}${detail}`
    }
  }
}

/** Projected per-session indexing state: active while any work-done token runs. */
export type ClangdIndexingState = { active: true; percentage?: number } | { active: false }

export type ClangdIndexingTracker = {
  /** Structured indexing projection; undefined when the event carries none. */
  reduce(params: unknown): ClangdIndexingState | undefined
}

/**
 * Tracks clangd work-done tokens (`$/progress`) as one structured indexing
 * state — token-set semantics mirroring `createClangdProgressTracker`'s titles
 * map: begin adds, end removes, report updates the latest percentage. Unknown
 * kinds and stray tokens are dropped (clangd reports non-indexing work here).
 */
export function createClangdIndexingTracker(): ClangdIndexingTracker {
  // token -> last reported percentage, so `end` can fall back to a sibling's.
  const tokens = new Map<string | number, number | undefined>()
  let latest: string | number | null = null
  return {
    reduce(params: unknown): ClangdIndexingState | undefined {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: $/progress params are the wire-deserialized LSP payload; every field is read through optional chaining, so an unknown shape yields undefined.
      const p = params as {
        token?: string | number
        value?: { kind?: string; percentage?: number }
      } | null
      const token = p?.token
      const value = p?.value
      if (token === undefined) {
        return undefined
      }
      if (value?.kind === 'begin') {
        tokens.set(token, typeof value.percentage === 'number' ? value.percentage : undefined)
        latest = token
      } else if (value?.kind === 'report') {
        if (!tokens.has(token)) {
          return undefined
        }
        const prior = tokens.get(token)
        tokens.set(token, typeof value.percentage === 'number' ? value.percentage : prior)
        latest = token
      } else if (value?.kind === 'end') {
        tokens.delete(token)
        if (latest === token) {
          latest = [...tokens.keys()].at(-1) ?? null
        }
      } else {
        return undefined
      }
      if (tokens.size === 0) {
        return { active: false }
      }
      const percentage = latest !== null ? tokens.get(latest) : undefined
      return { active: true, ...(percentage !== undefined ? { percentage } : {}) }
    }
  }
}

type RawLocation = {
  uri?: string
  range?: {
    start?: { line: number; character: number }
    end?: { line: number; character: number }
  }
} | null

/** LSP definition result (single | array | null) -> semantic locations. */
export function mapClangdDefinitionResult(
  result: unknown,
  lspUriToPath: (uri: string) => string
): LanguageServerDefinitionLocation[] {
  return mapClangdLocationResult(result, lspUriToPath)
}

/**
 * LSP `Location | Location[] | null` -> semantic navigation locations. The
 * definition/declaration/references results share this shape; references may
 * list many sites, declaration/definition usually one.
 */
export function mapClangdLocationResult(
  result: unknown,
  lspUriToPath: (uri: string) => string
): LanguageServerDefinitionLocation[] {
  const raw = Array.isArray(result) ? result : result ? [result] : []
  const locations: LanguageServerDefinitionLocation[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the result is normalized to an array above; each item is validated (uri/range present) before use, so a malformed item is skipped.
  for (const item of raw as RawLocation[]) {
    if (!item?.uri || !item.range?.start || !item.range.end) {
      continue
    }
    locations.push({
      path: lspUriToPath(item.uri),
      range: {
        startLine: item.range.start.line,
        startCharacter: item.range.start.character,
        endLine: item.range.end.line,
        endCharacter: item.range.end.character
      }
    })
  }
  return locations
}

/** LSP hover result (all legal content shapes) -> semantic hover or null. */
export function mapClangdHoverResult(result: unknown): LanguageServerHoverContent | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hover result is the wire-deserialized LSP payload; `contents` is read through optional chaining and re-narrowed by typeof/Array.isArray below.
  const contents = (result as { contents?: unknown } | null)?.contents
  if (typeof contents === 'string') {
    return { kind: 'plaintext', value: contents }
  }
  if (Array.isArray(contents)) {
    const value = contents
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : String(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hover `contents` array entries are LSP string|MarkedString; typeof narrows the string variant, this handles the object's `value`.
              (entry as { value?: string })?.value ?? ''
            )
      )
      .filter(Boolean)
      .join('\n\n')
    return value ? { kind: 'plaintext', value } : null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: at this point `contents` is neither string nor array (guarded above), so it is the MarkupContent object variant; `value` is checked before use.
  const markup = contents as { kind?: string; value?: string } | null
  if (!markup?.value) {
    return null
  }
  return { kind: markup.kind === 'plaintext' ? 'plaintext' : 'markdown', value: markup.value }
}

type RawSymbolRange = {
  start?: { line: number; character: number }
  end?: { line: number; character: number }
} | null

/** One wire item covering both legal shapes: DocumentSymbol | SymbolInformation. */
type RawDocumentSymbolItem = {
  name?: unknown
  kind?: unknown
  range?: RawSymbolRange
  selectionRange?: RawSymbolRange
  children?: unknown
  location?: { range?: RawSymbolRange } | null
  containerName?: unknown
} | null

function isSymbolKindValue(kind: unknown): kind is LanguageServerSymbolKind {
  return typeof kind === 'number' && Number.isInteger(kind) && kind >= 1 && kind <= 26
}

function mapSymbolRange(range: RawSymbolRange | undefined): LanguageServerSymbolRange | null {
  if (!range?.start || !range.end) {
    return null
  }
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character
  }
}

function copySymbolNode(item: RawDocumentSymbolItem): LanguageServerDocumentSymbolNode | null {
  if (typeof item?.name !== 'string' || !item.name || !isSymbolKindValue(item.kind)) {
    return null
  }
  const range = mapSymbolRange(item.range)
  const selectionRange = mapSymbolRange(item.selectionRange)
  if (!range || !selectionRange) {
    return null
  }
  const children = Array.isArray(item.children) ? item.children : []
  return {
    name: item.name,
    kind: item.kind,
    range,
    selectionRange,
    children: children
      .map((child) => copySymbolNode(child))
      .filter((node): node is LanguageServerDocumentSymbolNode => node !== null)
  }
}

function copySymbolInformationItem(
  item: RawDocumentSymbolItem
): LanguageServerSymbolInformationItem | null {
  if (typeof item?.name !== 'string' || !item.name || !isSymbolKindValue(item.kind)) {
    return null
  }
  const range = mapSymbolRange(item.location?.range)
  if (!range) {
    return null
  }
  return {
    name: item.name,
    kind: item.kind,
    range,
    ...(typeof item.containerName === 'string' ? { containerName: item.containerName } : {})
  }
}

/**
 * LSP `DocumentSymbol[] | SymbolInformation[] | null` -> the mirror payload.
 * The variant is decided by the first element (children/selectionRange =>
 * hierarchical, else flat via `location`), mirroring main's normalization;
 * malformed items are skipped, never thrown. Null/empty => empty hierarchical
 * (a truly empty file, distinct from the ok:false/null failure result).
 */
export function mapClangdDocumentSymbolResult(
  result: unknown
): LanguageServerDocumentSymbolPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: documentSymbol result is the wire-deserialized LSP payload; every item is narrowed field-by-field below and malformed items are skipped.
  const raw = Array.isArray(result) ? (result as RawDocumentSymbolItem[]) : []
  if (raw.length === 0) {
    return { kind: 'hierarchical', roots: [] }
  }
  const first = raw[0]
  if (first && ('children' in first || 'selectionRange' in first)) {
    return {
      kind: 'hierarchical',
      roots: raw
        .map((item) => copySymbolNode(item))
        .filter((node): node is LanguageServerDocumentSymbolNode => node !== null)
    }
  }
  return {
    kind: 'flat',
    items: raw
      .map((item) => copySymbolInformationItem(item))
      .filter((entry): entry is LanguageServerSymbolInformationItem => entry !== null)
  }
}
