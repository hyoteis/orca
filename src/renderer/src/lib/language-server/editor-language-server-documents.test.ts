import { describe, expect, it } from 'vitest'
import { collectEditorLanguageServerDocuments } from './editor-language-server-documents'
import type { OpenFile } from '@/store/slices/editor'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { isCodeIntelligenceResultVisible } from './code-intelligence-scope-membership'
const scope: CodeIntelligenceScope = {
  id: 'scope',
  name: 'Scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/repo',
  language: 'python',
  members: [
    { relativePath: 'src', visibleResults: true },
    { relativePath: 'generated', visibleResults: false }
  ],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}
const file = (overrides: Partial<OpenFile> = {}): OpenFile => ({
  id: '/repo/a.py',
  filePath: '/repo/a.py',
  relativePath: 'src/a.py',
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
      acceptsLanguage: (l) => l === 'python',
      scope
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ draftText: 'draft', diskText: 'disk' })
  })
  it('synchronizes only documents inside positive scope members', () => {
    const docs = collectEditorLanguageServerDocuments({
      openFiles: [
        file({ id: 'inside', relativePath: 'src/a.py' }),
        file({ id: 'hidden-result', relativePath: 'generated/a.py' }),
        file({ id: 'outside', relativePath: 'vendor/a.py' })
      ],
      editorDrafts: { inside: 'a', 'hidden-result': 'b', outside: 'c' },
      diskTextByFileId: {},
      toUri: (item) => item.filePath,
      acceptsLanguage: () => true,
      scope
    })
    expect(docs.map((doc) => doc.documentId)).toEqual(['inside', 'hidden-result'])
    expect(isCodeIntelligenceResultVisible(scope, 'src/a.py')).toBe(true)
    expect(isCodeIntelligenceResultVisible(scope, 'generated/a.py')).toBe(false)
    expect(isCodeIntelligenceResultVisible(scope, 'vendor/a.py')).toBe(false)
    expect(
      isCodeIntelligenceResultVisible(
        {
          members: [
            { relativePath: '.', visibleResults: true },
            { relativePath: 'generated', visibleResults: false }
          ]
        },
        'generated/a.py'
      )
    ).toBe(false)
  })

  it('waits for content when a restored clean tab has no draft', () => {
    expect(
      collectEditorLanguageServerDocuments({
        openFiles: [file({ isDirty: false })],
        editorDrafts: {},
        diskTextByFileId: {},
        toUri: (f) => f.filePath,
        acceptsLanguage: () => true,
        scope
      })
    ).toEqual([])
  })
})
