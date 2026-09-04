import { describe, expect, it, vi } from 'vitest'
import { LanguageServerDocumentRegistry } from './language-server-document-registry'
describe('LanguageServerDocumentRegistry', () => {
  it('deduplicates panes, versions drafts, and closes after final reference', () => {
    const sendNotification = vi.fn(),
      registry = new LanguageServerDocumentRegistry({ sendNotification })
    const doc = { uri: 'file:///a.py', languageId: 'python', text: 'a' }
    registry.open(doc)
    registry.open(doc)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(registry.change(doc.uri, 'dirty')).toBe(2)
    registry.close(doc.uri)
    expect(registry.snapshot()).toHaveLength(1)
    registry.close(doc.uri)
    expect(registry.snapshot()).toHaveLength(0)
    expect(sendNotification).toHaveBeenCalledTimes(3)
  })
})
