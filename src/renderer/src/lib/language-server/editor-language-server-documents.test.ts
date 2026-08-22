import { describe, expect, it } from 'vitest'
import { collectEditorLanguageServerDocuments } from './editor-language-server-documents'
import type { OpenFile } from '@/store/slices/editor'
const file = (overrides: Partial<OpenFile> = {}): OpenFile => ({
  id: '/repo/a.py',
  filePath: '/repo/a.py',
  relativePath: 'a.py',
  worktreeId: 'w',
  language: 'python',
  isDirty: true,
  mode: 'edit',
  ...overrides
})
describe('collectEditorLanguageServerDocuments', () => {
  it('prefers restored drafts and excludes virtual/read-only models', () => {
    const docs = collectEditorLanguageServerDocuments({
      openFiles: [file(), file({ id: 'diff', mode: 'diff' }), file({ id: 'log', readOnly: true })],
      editorDrafts: { '/repo/a.py': 'draft' },
      diskTextByFileId: { '/repo/a.py': 'disk' },
      toUri: (f) => `file://${f.filePath}`,
      acceptsLanguage: (l) => l === 'python'
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ draftText: 'draft', diskText: 'disk' })
  })
  it('waits for content when a restored clean tab has no draft', () => {
    expect(
      collectEditorLanguageServerDocuments({
        openFiles: [file({ isDirty: false })],
        editorDrafts: {},
        diskTextByFileId: {},
        toUri: (f) => f.filePath,
        acceptsLanguage: () => true
      })
    ).toEqual([])
  })
})
