import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  type MessageConnection
} from 'vscode-languageserver-protocol'

export type SyncedDocumentSnapshot = { uri: string; languageId: string; text: string }
type Entry = SyncedDocumentSnapshot & { version: number; references: number }
export class LanguageServerDocumentRegistry {
  private readonly documents = new Map<string, Entry>()
  constructor(private connection: Pick<MessageConnection, 'sendNotification'>) {}
  open(snapshot: SyncedDocumentSnapshot): void {
    const current = this.documents.get(snapshot.uri)
    if (current) {
      current.references += 1
      if (current.text !== snapshot.text) this.change(snapshot.uri, snapshot.text)
      return
    }
    const entry: Entry = { ...snapshot, version: 1, references: 1 }
    this.documents.set(snapshot.uri, entry)
    this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: entry.uri,
        languageId: entry.languageId,
        version: entry.version,
        text: entry.text
      }
    })
  }
  change(uri: string, text: string): number {
    const entry = this.require(uri)
    entry.version += 1
    entry.text = text
    this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: entry.version },
      contentChanges: [{ text }]
    })
    return entry.version
  }
  close(uri: string): void {
    const entry = this.documents.get(uri)
    if (!entry) return
    entry.references -= 1
    if (entry.references > 0) return
    this.documents.delete(uri)
    this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri }
    })
  }
  rename(oldUri: string, next: SyncedDocumentSnapshot): void {
    const old = this.documents.get(oldUri)
    if (!old) return
    const refs = old.references
    this.documents.delete(oldUri)
    this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri: oldUri }
    })
    const entry: Entry = { ...next, version: 1, references: refs }
    this.documents.set(next.uri, entry)
    this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: entry.uri,
        languageId: entry.languageId,
        version: entry.version,
        text: entry.text
      }
    })
  }
  resynchronize(connection: Pick<MessageConnection, 'sendNotification'>): void {
    this.connection = connection
    for (const entry of this.documents.values()) {
      entry.version = 1
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: entry.uri, languageId: entry.languageId, version: 1, text: entry.text }
      })
    }
  }
  snapshot(): readonly Readonly<Entry>[] {
    return [...this.documents.values()].map((entry) => ({ ...entry }))
  }
  private require(uri: string): Entry {
    const entry = this.documents.get(uri)
    if (!entry) throw new Error(`Language server document is not open: ${uri}`)
    return entry
  }
}
