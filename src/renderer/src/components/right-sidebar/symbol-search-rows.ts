import type {
  SymbolInformation,
  WorkspaceSymbol
} from 'vscode-languageserver-protocol'
import type { WorkspaceSymbolFanout } from '@/lib/language-server/code-intelligence-workspace'
import {
  fileUriToHostPath,
  relativeToRoot
} from '@/lib/language-server/code-intelligence-workspace'

/** What the rows need from each scope — hook builds this from settings. */
export type SymbolScopeInfo = { workspaceRoot: string; executionHostId: string }

export type SymbolRow = {
  key: string
  name: string
  containerName: string
  kindLabel: string
  scopeId: string
  scopeName: string
  uri: string
  /** Workspace-relative path, or the host path when the symbol is external (#13). */
  displayPath: string
  /** True when the symbol lives outside every scope root (external dependency). */
  external: boolean
  /** Null until workspaceSymbol/resolve runs — such rows render disabled. */
  range: SymbolInformation['location']['range'] | null
}

// LSP SymbolKind 1..26; index 0 unused.
const KIND_LABELS: readonly string[] = [
  '',
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter'
]

function symbolRange(symbol: SymbolInformation | WorkspaceSymbol): SymbolRow['range'] {
  return 'range' in symbol.location ? symbol.location.range : null
}

export function buildSymbolSearchRows(
  result: WorkspaceSymbolFanout,
  scopeInfoById: ReadonlyMap<string, SymbolScopeInfo>
): SymbolRow[] {
  const rows: SymbolRow[] = []
  for (const scopeResult of result.results) {
    const info = scopeInfoById.get(scopeResult.scopeId)
    for (const symbol of scopeResult.symbols) {
      const hostPath = info ? fileUriToHostPath(symbol.location.uri, info.executionHostId) : null
      const inRoot = hostPath && info ? relativeToRoot(hostPath, info.workspaceRoot) : null
      rows.push({
        key: `${scopeResult.scopeId}:${symbol.location.uri}:${symbol.name}`,
        name: symbol.name,
        containerName: symbol.containerName ?? '',
        kindLabel: KIND_LABELS[symbol.kind] ?? 'Symbol',
        scopeId: scopeResult.scopeId,
        scopeName: scopeResult.scopeName,
        uri: symbol.location.uri,
        displayPath: inRoot ?? hostPath ?? symbol.location.uri,
        external: inRoot === null,
        range: symbolRange(symbol)
      })
    }
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}
