import type * as Monaco from 'monaco-editor'
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol'

// LSP SymbolKind 1..26 and monaco SymbolKind 0..25 share ordering.
function monacoSymbolTags(symbol: { deprecated?: boolean }): Monaco.languages.SymbolTag[] {
  return symbol.deprecated ? [1 satisfies Monaco.languages.SymbolTag] : []
}

export function toMonacoRange(range: {
  start: { line: number; character: number }
  end: { line: number; character: number }
}): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

/** Shared by the Python and C++ Monaco document-symbol providers (#100). */
export function lspSymbolsToMonaco(
  symbols: DocumentSymbol[] | SymbolInformation[]
): Monaco.languages.DocumentSymbol[] {
  return symbols.map((symbol) =>
    'location' in symbol
      ? {
          name: symbol.name,
          detail: symbol.containerName ?? '',
          kind: (symbol.kind - 1) as Monaco.languages.SymbolKind,
          tags: monacoSymbolTags(symbol),
          range: toMonacoRange(symbol.location.range),
          selectionRange: toMonacoRange(symbol.location.range)
        }
      : {
          name: symbol.name,
          detail: symbol.detail ?? '',
          kind: (symbol.kind - 1) as Monaco.languages.SymbolKind,
          tags: monacoSymbolTags(symbol),
          range: toMonacoRange(symbol.range),
          selectionRange: toMonacoRange(symbol.selectionRange),
          children: symbol.children ? lspSymbolsToMonaco(symbol.children) : undefined
        }
  )
}
