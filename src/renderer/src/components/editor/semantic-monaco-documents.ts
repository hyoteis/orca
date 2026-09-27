import { toEditorModelUri } from './editor-model-uri'

// Structural subsets of the Monaco surfaces the outline consumes. The real
// standalone editor and its ITextModel satisfy them, and tests build fakes
// without casts. Only file-editor surfaces mount MonacoEditor, whose
// handleMount is the sole registration point (#23) — the outline resolves the
// active edit tab by path, and same-path surfaces share the retained model.

export type SemanticMonacoModel = {
  uri: { toString(): string }
  getValue(): string
  /** Edit nonce for the outline result-cache key; absent on minimal fakes. */
  getVersionId?(): number
  onDidChangeContent(listener: () => void): { dispose(): void }
}

export type SemanticMonacoEditor = {
  getModel(): SemanticMonacoModel | null
  getPosition?(): { lineNumber: number } | null
  onDidChangeCursorPosition(listener: (event: { position: { lineNumber: number } }) => void): {
    dispose(): void
  }
}

type DocumentEntry = {
  /** Idempotency token: an old unregister must not delete a newer registration. */
  token: symbol
  editor: SemanticMonacoEditor
  model: SemanticMonacoModel
}

const documents = new Map<string, DocumentEntry>()
const documentListeners = new Set<() => void>()

/** Live document-registry changes; Outline re-derives its query when the
 * active editor registers a moment after the panel mounts. */
export function subscribeSemanticDocuments(listener: () => void): () => void {
  documentListeners.add(listener)
  return () => {
    documentListeners.delete(listener)
  }
}

function notifyDocumentListeners(): void {
  for (const listener of documentListeners) {
    listener()
  }
}

export function registerSemanticMonacoDocument(editor: SemanticMonacoEditor): () => void {
  const model = editor.getModel()
  if (!model) {
    return () => undefined
  }
  const key = model.uri.toString()
  const entry = { token: Symbol(key), editor, model }
  documents.set(key, entry)
  notifyDocumentListeners()
  return () => {
    if (documents.get(key)?.token === entry.token) {
      documents.delete(key)
      notifyDocumentListeners()
    }
  }
}

/** Editor+model backing an open document's live text; the outline's
 * debounced refresh, cursor follow, and heuristic rows all read through it. */
export function semanticDocumentEditorFor(filePath: string): {
  editor: SemanticMonacoEditor
  model: SemanticMonacoModel
} | null {
  const entry = documents.get(toEditorModelUri(filePath))
  return entry ? { editor: entry.editor, model: entry.model } : null
}
