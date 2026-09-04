import type * as Monaco from 'monaco-editor'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'
import { applyDocumentTextEdits } from './document-semantic-edits'
import type { SemanticMonacoLanguageApi } from './semantic-monaco-providers'

type DocumentContext = {
  token: symbol
  requestAt: (position: Monaco.IPosition) => CodeIntelligenceDocumentRequest | null
  editor: Monaco.editor.IStandaloneCodeEditor
}

const documents = new Map<string, DocumentContext>()
export function requestAtPosition(model: Monaco.editor.ITextModel, position: Monaco.IPosition) {
  return documents.get(model.uri.toString())?.requestAt(position) ?? null
}

export function registerSemanticMonacoDocument(
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: DocumentContext['requestAt']
): () => void {
  const model = editor.getModel()
  if (!model) {
    return () => undefined
  }
  const key = model.uri.toString()
  const context = { token: Symbol(key), requestAt, editor }
  documents.set(key, context)
  return () => {
    if (documents.get(key)?.token === context.token) {
      documents.delete(key)
    }
  }
}

export const SEMANTIC_CODE_ACTION_COMMAND = 'orca.semantic.codeAction'

/**
 * Format-on-save (#20): applies whole-document formatting to the open draft as
 * one undo group before the save lands. Scope-gated and capability-gated; a
 * null result saves the draft unchanged. Returns true when content changed.
 */
const languageApis = new Map<string, SemanticMonacoLanguageApi>()

/** Registered per-language request surface; installSemanticMonacoProviders feeds it. */
export function registerSemanticLanguageApi(language: string, api: SemanticMonacoLanguageApi): void {
  languageApis.set(language, api)
}

export async function formatDocumentBeforeSave(
  request: CodeIntelligenceDocumentRequest,
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<boolean> {
  const api = languageApis.get(request.language)
  const model = editor.getModel()
  if (!api || !model || !api.formatOnSaveEnabled(request)) {
    return false
  }
  const edits = await api
    .getFormattingEdits(
      request,
      { tabSize: model.getOptions().tabSize, insertSpaces: model.getOptions().insertSpaces },
      undefined
    )
    .catch(() => null)
  if (!edits || request.documentVersion !== model.getVersionId()) {
    return false
  }
  return applyDocumentTextEdits({
    editor,
    model,
    edits,
    baseVersion: request.documentVersion,
    source: 'orca.semanticFormatOnSave'
  })
}

/** Editor+model backing an open document's semantic context; code-action and
 * tier-1 execution need it to write the draft and validate versions. */
export function semanticDocumentEditorFor(fileId: string): {
  editor: Monaco.editor.IStandaloneCodeEditor
  model: Monaco.editor.ITextModel
} | null {
  for (const entry of documents.values()) {
    const model = entry.editor.getModel()
    if (model && entry.requestAt({ lineNumber: 1, column: 1 })?.fileId === fileId) {
      return { editor: entry.editor, model }
    }
  }
  return null
}

