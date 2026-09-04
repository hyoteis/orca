import type * as Monaco from 'monaco-editor'
import { completionTextEditSet } from './document-semantic-edits'
import {
  CancellationTokenSource,
  InsertTextFormat,
  type CancellationToken,
  type CompletionItem,
  type Diagnostic,
  type SignatureHelp,
  type TextEdit
} from 'vscode-languageserver-protocol'

/** LSP CompletionItemKind (1..25) → monaco CompletionItemKind (0-based). */
const LSP_TO_MONACO_COMPLETION_KIND: readonly number[] = [
  18, // Text
  0, // Method
  1, // Function
  2, // Constructor
  3, // Field
  4, // Variable
  5, // Class
  7, // Interface
  8, // Module
  9, // Property
  12, // Unit
  13, // Value
  15, // Enum
  17, // Keyword
  28, // Snippet
  19, // Color
  20, // File
  21, // Reference
  22, // Folder
  16, // EnumMember
  14, // Constant
  6, // Struct
  10, // Event
  11, // Operator
  23 // TypeParameter
]

function toMonacoRange(range: {
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

/** Bridges a monaco cancellation token into an LSP token that actually cancels. */
export function toLspCancellationToken(token: Monaco.CancellationToken): CancellationToken {
  const source = new CancellationTokenSource()
  token.onCancellationRequested(() => source.cancel())
  return source.token
}

export function lspToMonacoTextEdit(edit: TextEdit): Monaco.languages.TextEdit {
  return { range: toMonacoRange(edit.range), text: edit.newText }
}

/** Completion items are read-only suggestions (#20): the server's `command`
 * field is dropped because completion commands never auto-run. */
export function lspToMonacoCompletionItem(args: {
  item: CompletionItem
  wordRange: Monaco.IRange
}): Monaco.languages.CompletionItem {
  const { item, wordRange } = args
  const textEdit = 'textEdit' in item && item.textEdit ? item.textEdit : null
  const insertText =
    textEdit && 'newText' in textEdit ? textEdit.newText : (item.insertText ?? item.label)
  // #20: additional edits ride along only when they do not touch the primary span.
  const additional = textEdit && 'range' in textEdit && item.additionalTextEdits
    ? completionTextEditSet(
        { range: textEdit.range, newText: insertText },
        item.additionalTextEdits
      ).slice(0, -1)
    : (item.additionalTextEdits ?? [])
  return {
    label: item.label,
    kind: (LSP_TO_MONACO_COMPLETION_KIND[(item.kind ?? 1) - 1] ?? 18) as Monaco.languages.CompletionItemKind,
    tags: item.deprecated ? [1] : undefined,
    detail: item.detail,
    documentation:
      typeof item.documentation === 'string'
        ? item.documentation
        : item.documentation?.value
          ? { value: item.documentation.value }
          : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    insertText,
    insertTextRules: item.insertTextFormat === InsertTextFormat.Snippet ? 4 : undefined,
    range:
      textEdit && 'range' in textEdit ? toMonacoRange(textEdit.range) : wordRange,
    additionalTextEdits: additional.map(lspToMonacoTextEdit)
  }
}

/** Monaco SignatureHelp is structurally LSP-shaped; only ranges shift by one. */
export function lspToMonacoSignatureHelp(help: SignatureHelp): Monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      documentation:
        typeof signature.documentation === 'string'
          ? signature.documentation
          : signature.documentation?.value
            ? { value: signature.documentation.value }
            : undefined,
      activeParameter: signature.activeParameter ?? undefined,
      parameters: (signature.parameters ?? []).map((parameter) => ({
        label: parameter.label,
        documentation:
          typeof parameter.documentation === 'string'
            ? parameter.documentation
            : parameter.documentation?.value
              ? { value: parameter.documentation.value }
              : undefined
      }))
    })),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0
  }
}

/** Marker severity (8,4,2,1) → LSP DiagnosticSeverity (1..4). */
export function monacoMarkerToLspDiagnostic(
  marker: Monaco.editor.IMarkerData
): Diagnostic {
  const severity =
    marker.severity === 8 ? 1 : marker.severity === 4 ? 2 : marker.severity === 2 ? 3 : 4
  return {
    range: {
      start: {
        line: (marker.startLineNumber ?? 1) - 1,
        character: (marker.startColumn ?? 1) - 1
      },
      end: { line: (marker.endLineNumber ?? 1) - 1, character: (marker.endColumn ?? 1) - 1 }
    },
    message: marker.message,
    severity: severity as Diagnostic['severity'],
    source: marker.source ?? undefined
  }
}
