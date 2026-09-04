import { describe, expect, it, vi } from 'vitest'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  commitGuardedWorkspaceEdit,
  singleDocumentWorkspaceEdits,
  undoLatestSemanticWorkspaceEdit
} from './semantic-workspace-edit-flow'
import { WorkspaceEditUndoStack } from './workspace-edit-undo-stack'
import type { WorkspaceEditPlanView } from './workspace-edit-plan'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'
import type { OpenFile } from '@/store/slices/editor'

const scope: CodeIntelligenceScope = {
  id: 'local:w:python',
  name: 'Scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/repo',
  language: 'python',
  members: [{ path: '/repo/src', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

const edit = (range: { sl: number; sc: number; el: number; ec: number }, text: string): TextEdit =>
  ({
    range: {
      start: { line: range.sl, character: range.sc },
      end: { line: range.el, character: range.ec }
    },
    newText: text
  }) as TextEdit

const documentEdit = (
  uri: string,
  edits: TextEdit[],
  version: number | null = null
): WorkspaceEdit => ({
  documentChanges: [
    { textDocument: { uri, version }, edits }
  ] as WorkspaceEdit['documentChanges']
})

const view = (overrides: Partial<WorkspaceEditPlanView> = {}): WorkspaceEditPlanView => ({
  openDocumentFor: () => null,
  readText: async (path) => (path === '/repo/src/a.py' ? 'old text\n' : null),
  exists: async (path) => path === '/repo/src/a.py',
  ...overrides
})

const ports = (
  overrides: Partial<WorkspaceEditTransactionPorts> = {}
): WorkspaceEditTransactionPorts => ({
  readText: async () => 'old text\n',
  exists: async () => true,
  writeAtomic: vi.fn(async () => undefined),
  createFile: vi.fn(async () => undefined),
  renamePath: vi.fn(async () => undefined),
  deletePath: vi.fn(async () => undefined),
  quiesceEditorSaves: vi.fn(async () => undefined),
  openDocumentFor: () => null,
  ...overrides
})

const openFiles: OpenFile[] = [
  {
    id: 'file-1',
    filePath: '/repo/src/a.py',
    relativePath: 'src/a.py',
    worktreeId: 'w',
    language: 'python',
    isDirty: false,
    mode: 'edit'
  } as OpenFile
]

describe('singleDocumentWorkspaceEdits', () => {
  const uri = 'file:///repo/src/a.py'

  it('returns edits when changes cover only the current document', () => {
    const result = singleDocumentWorkspaceEdits(
      { changes: { [uri]: [edit({ sl: 0, sc: 0, el: 0, ec: 3 }, 'new')] } },
      uri
    )
    expect(result).toEqual([edit({ sl: 0, sc: 0, el: 0, ec: 3 }, 'new')])
  })

  it('returns null when another document is involved', () => {
    const other = 'file:///repo/src/b.py'
    expect(
      singleDocumentWorkspaceEdits(
        { changes: { [uri]: [], [other]: [] } } as WorkspaceEdit,
        uri
      )
    ).toBeNull()
    expect(
      singleDocumentWorkspaceEdits({ changes: { [other]: [] } } as WorkspaceEdit, uri)
    ).toBeNull()
  })

  it('returns null for multi-document or resource documentChanges', () => {
    const other = 'file:///repo/src/b.py'
    const twoDocuments = {
      documentChanges: [...documentEdit(uri, []).documentChanges!, ...documentEdit(other, []).documentChanges!]
    } as WorkspaceEdit
    expect(singleDocumentWorkspaceEdits(twoDocuments, uri)).toBeNull()
    expect(
      singleDocumentWorkspaceEdits({ documentChanges: [{ kind: 'create', uri }] } as WorkspaceEdit, uri)
    ).toBeNull()
  })

  it('returns merged edits for same-document TextDocumentEdits at a matching version', () => {
    const result = singleDocumentWorkspaceEdits(
      documentEdit(uri, [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')], 4),
      uri,
      { syncedVersion: 4 }
    )
    expect(result).toEqual([edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')])
  })

  it('returns null when the server edit pins a different document version', () => {
    expect(
      singleDocumentWorkspaceEdits(documentEdit(uri, [], 4), uri, { syncedVersion: 7 })
    ).toBeNull()
  })

  it('returns null for an empty edit', () => {
    expect(singleDocumentWorkspaceEdits({}, uri)).toBeNull()
  })
})

describe('commitGuardedWorkspaceEdit', () => {
  it('blocks without confirmation when a target is unauthorized', async () => {
    const confirm = vi.fn(async () => true)
    const transactionPorts = ports()
    const result = await commitGuardedWorkspaceEdit({
      edit: { changes: { 'file:///outside/x.py': [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')] } },
      scope,
      operationHostId: 'local',
      view: view(),
      ports: transactionPorts,
      confirm,
      openFiles,
      worktreePathFor: () => '/repo'
    })
    expect(result).toMatchObject({ kind: 'outcome', outcome: { status: 'blocked' } })
    expect(confirm).not.toHaveBeenCalled()
    expect(transactionPorts.writeAtomic).not.toHaveBeenCalled()
  })

  it('cancels without committing when confirmation is declined', async () => {
    const confirm = vi.fn(async () => false)
    const transactionPorts = ports()
    const result = await commitGuardedWorkspaceEdit({
      edit: documentEdit('file:///repo/src/a.py', [edit({ sl: 0, sc: 0, el: 0, ec: 8 }, 'new text')]),
      scope,
      operationHostId: 'local',
      view: view(),
      ports: transactionPorts,
      confirm,
      openFiles,
      worktreePathFor: () => '/repo'
    })
    expect(result).toEqual({ kind: 'cancelled' })
    expect(transactionPorts.writeAtomic).not.toHaveBeenCalled()
  })

  it('commits, projects, and records undo after confirmation', async () => {
    const transactionPorts = ports()
    const projection: string[] = []
    const result = await commitGuardedWorkspaceEdit({
      edit: documentEdit('file:///repo/src/a.py', [edit({ sl: 0, sc: 0, el: 0, ec: 8 }, 'new text')]),
      scope,
      operationHostId: 'local',
      view: view(),
      ports: transactionPorts,
      confirm: async () => true,
      project: async (steps) => {
        projection.push(String(steps.length))
      },
      openFiles,
      worktreePathFor: () => '/repo'
    })
    expect(result).toMatchObject({
      kind: 'outcome',
      outcome: { status: 'committed' }
    })
    expect(transactionPorts.writeAtomic).toHaveBeenCalledWith(
      '/repo/src/a.py',
      'new text\n'
    )
    expect(projection).toEqual(['1'])
  })
})

describe('undoLatestSemanticWorkspaceEdit', () => {
  it('returns null when no undo entry exists', async () => {
    expect(
      await undoLatestSemanticWorkspaceEdit({
        ports: ports(),
        stack: new WorkspaceEditUndoStack(),
        openFiles: [],
        worktreePathFor: () => null
      })
    ).toEqual({ kind: 'outcome', outcome: null })
  })

  it('projects after a committed undo', async () => {
    const undoStack = new WorkspaceEditUndoStack()
    // Seed the session undo stack through a committed guarded edit.
    await commitGuardedWorkspaceEdit({
      edit: documentEdit('file:///repo/src/a.py', [edit({ sl: 0, sc: 0, el: 0, ec: 8 }, 'new text')]),
      scope,
      operationHostId: 'local',
      view: view(),
      ports: ports({ readText: async () => 'new text\n' }),
      confirm: async () => true,
      stack: undoStack,
      openFiles,
      worktreePathFor: () => '/repo'
    })
    const projection: string[] = []
    const undoPorts = ports({ readText: async () => 'new text\n' })
    const result = await undoLatestSemanticWorkspaceEdit({
      ports: undoPorts,
      project: async (steps) => {
        projection.push(String(steps.length))
      },
      openFiles,
      worktreePathFor: () => '/repo'
    })
    expect(result).toMatchObject({ kind: 'outcome', outcome: { status: 'committed' } })
    expect(undoPorts.writeAtomic).toHaveBeenCalledWith('/repo/src/a.py', 'old text\n')
    expect(projection).toEqual(['1'])
  })
})
