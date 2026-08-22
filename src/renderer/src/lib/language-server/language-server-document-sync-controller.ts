import type { TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol'
import type { LanguageServerDocumentRegistry } from './language-server-document-registry'

export type LanguageServerDocumentSource = {
  documentId: string
  uri: string
  languageId: string
  diskText: string
  draftText?: string
  references?: number
}

type TrackedSource = { uri: string; languageId: string; text: string; references: number }

export class LanguageServerDocumentSyncController {
  private readonly sources = new Map<string, TrackedSource>()
  constructor(private readonly documents: LanguageServerDocumentRegistry) {}

  reconcile(nextSources: readonly LanguageServerDocumentSource[]): void {
    const next = new Map<string, TrackedSource>()
    for (const source of nextSources) {
      const references = Math.max(1, source.references ?? 1)
      next.set(source.documentId, {
        uri: source.uri,
        languageId: source.languageId,
        text: source.draftText ?? source.diskText,
        references
      })
    }
    for (const [documentId, prior] of this.sources) {
      if (!next.has(documentId)) {
        this.closeReferences(prior.uri, prior.references)
      }
    }
    for (const [documentId, current] of next) {
      const prior = this.sources.get(documentId)
      if (!prior) {
        this.openReferences(current)
        continue
      }
      if (prior.uri !== current.uri) {
        this.documents.rename(prior.uri, current)
      } else if (prior.text !== current.text) {
        this.documents.change(current.uri, current.text)
      }
      this.adjustReferences(current, prior.references, current.references)
    }
    this.sources.clear()
    for (const [id, source] of next) {
      this.sources.set(id, source)
    }
  }

  applyIncremental(
    documentId: string,
    text: string,
    changes: TextDocumentContentChangeEvent[]
  ): number {
    const source = this.sources.get(documentId)
    if (!source) {
      throw new Error(`Language server document source is not registered: ${documentId}`)
    }
    source.text = text
    return this.documents.changeIncremental(source.uri, text, changes)
  }

  resynchronize(connection: Parameters<LanguageServerDocumentRegistry['resynchronize']>[0]): void {
    this.documents.resynchronize(connection)
  }

  dispose(): void {
    this.sources.clear()
    this.documents.closeAll()
  }

  private openReferences(source: TrackedSource): void {
    for (let index = 0; index < source.references; index += 1) {
      this.documents.open(source)
    }
  }
  private closeReferences(uri: string, references: number): void {
    for (let index = 0; index < references; index += 1) {
      this.documents.close(uri)
    }
  }
  private adjustReferences(source: TrackedSource, previous: number, next: number): void {
    if (next > previous) {
      for (let index = previous; index < next; index += 1) {
        this.documents.open(source)
      }
    } else {
      for (let index = next; index < previous; index += 1) {
        this.documents.close(source.uri)
      }
    }
  }
}
