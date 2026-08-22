import { describe, expect, it, vi } from 'vitest'
import { LanguageServerDocumentRegistry } from './language-server-document-registry'
import { LanguageServerDocumentSyncController } from './language-server-document-sync-controller'

describe('LanguageServerDocumentSyncController', () => {
  it('prefers restored dirty drafts and deduplicates pane references', () => {
    const sendNotification = vi.fn()
    const documents = new LanguageServerDocumentRegistry({ sendNotification })
    const controller = new LanguageServerDocumentSyncController(documents)
    controller.reconcile([
      {
        documentId: 'a',
        uri: 'file:///a.py',
        languageId: 'python',
        diskText: 'disk',
        draftText: 'draft',
        references: 2
      }
    ])
    expect(documents.snapshot()[0]).toMatchObject({ text: 'draft', references: 2 })
    expect(sendNotification).toHaveBeenCalledOnce()
    controller.reconcile([])
    expect(documents.snapshot()).toHaveLength(0)
  })
  it('routes external clean reloads, renames, and incremental Monaco changes', () => {
    const sendNotification = vi.fn()
    const documents = new LanguageServerDocumentRegistry({ sendNotification })
    const controller = new LanguageServerDocumentSyncController(documents)
    controller.reconcile([
      { documentId: 'a', uri: 'file:///a.cpp', languageId: 'cpp', diskText: 'one' }
    ])
    controller.reconcile([
      { documentId: 'a', uri: 'file:///a.cpp', languageId: 'cpp', diskText: 'two' }
    ])
    controller.reconcile([
      { documentId: 'a', uri: 'file:///b.cpp', languageId: 'cpp', diskText: 'two' }
    ])
    expect(controller.applyIncremental('a', 'three', [{ text: 'three' }])).toBe(2)
    expect(documents.snapshot()[0]).toMatchObject({ uri: 'file:///b.cpp', text: 'three' })
  })
  it('resynchronizes drafts and closes every document on teardown', () => {
    const first = vi.fn(),
      second = vi.fn()
    const documents = new LanguageServerDocumentRegistry({ sendNotification: first })
    const controller = new LanguageServerDocumentSyncController(documents)
    controller.reconcile([
      { documentId: 'a', uri: 'file:///a.py', languageId: 'python', diskText: 'draft' }
    ])
    controller.resynchronize({ sendNotification: second })
    expect(second).toHaveBeenCalledOnce()
    controller.dispose()
    expect(documents.snapshot()).toHaveLength(0)
  })
})
