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
  it('routes external clean reloads and renames', () => {
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
    expect(documents.snapshot()[0]).toMatchObject({ uri: 'file:///b.cpp', text: 'two' })
  })
  it('closes every document on teardown', () => {
    const documents = new LanguageServerDocumentRegistry({ sendNotification: vi.fn() })
    const controller = new LanguageServerDocumentSyncController(documents)
    controller.reconcile([
      { documentId: 'a', uri: 'file:///a.py', languageId: 'python', diskText: 'draft' }
    ])
    controller.dispose()
    expect(documents.snapshot()).toHaveLength(0)
  })
})
