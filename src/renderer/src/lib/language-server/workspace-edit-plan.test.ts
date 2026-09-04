import { describe, expect, it } from 'vitest'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import { planWorkspaceEdit, type WorkspaceEditPlanView } from './workspace-edit-plan'
import { applyWorkspaceTextEdits } from './workspace-edit-text-application'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

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

const view = (overrides: Partial<WorkspaceEditPlanView> = {}): WorkspaceEditPlanView => ({
  openDocumentFor: () => null,
  readText: async () => null,
  exists: async () => false,
  ...overrides
})

describe('planWorkspaceEdit', () => {
  it('plans writes from documentChanges with disk bases for unsynchronized files', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: 3 },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 5 }, 'hello')]
          },
          {
            textDocument: { uri: 'file:///repo/src/b.py', version: null },
            edits: [edit({ sl: 1, sc: 0, el: 1, ec: 0 }, 'x = 1\n')]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({
        openDocumentFor: (path) =>
          path === '/repo/src/a.py'
            ? { isDirty: false, syncedText: 'world\nsecond\n', syncedVersion: 3 }
            : null,
        readText: async (path) => (path === '/repo/src/b.py' ? 'first\nsecond\n' : null)
      })
    })
    expect(plan).toEqual({
      status: 'planned',
      steps: [
        {
          type: 'write',
          uri: 'file:///repo/src/a.py',
          hostPath: '/repo/src/a.py',
          baseContent: 'world\nsecond\n',
          baseSignature: expect.any(String),
          nextContent: 'hello\nsecond\n',
          documentVersion: 3
        },
        {
          type: 'write',
          uri: 'file:///repo/src/b.py',
          hostPath: '/repo/src/b.py',
          baseContent: 'first\nsecond\n',
          baseSignature: expect.any(String),
          nextContent: 'first\nx = 1\nsecond\n',
          documentVersion: null
        }
      ]
    })
  })

  it('maps legacy changes entries onto write steps', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        changes: { 'file:///repo/src/a.py': [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, '# t\n')] }
      },
      scope,
      operationHostId: 'local',
      view: view({ readText: async () => 'body\n' })
    })
    expect(plan.status).toBe('planned')
    const step = plan.status === 'planned' ? plan.steps[0] : undefined
    if (step?.type === 'write') {
      expect(step.nextContent).toBe('# t\nbody\n')
    }
  })

  it('blocks a stale synced document version', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: 2 },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({
        openDocumentFor: () => ({ isDirty: false, syncedText: 'a\n', syncedVersion: 4 })
      })
    })
    expect(plan).toEqual({
      status: 'blocked',
      blocks: [
        {
          uri: 'file:///repo/src/a.py',
          hostPath: '/repo/src/a.py',
          reason: 'stale-version',
          detail: 'document version 2 ≠ synced version 4'
        }
      ]
    })
  })

  it('blocks a dirty open editor', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: null },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({
        openDocumentFor: () => ({ isDirty: true, syncedText: 'draft\n', syncedVersion: 1 })
      })
    })
    expect(plan.status).toBe('blocked')
    if (plan.status === 'blocked') {
      expect(plan.blocks[0]?.reason).toBe('dirty-editor')
    }
  })

  it('blocks edits to missing files and out-of-scope or non-file targets', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/missing.py', version: null },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')]
          },
          {
            textDocument: { uri: 'file:///repo/vendor/a.py', version: null },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')]
          },
          {
            textDocument: { uri: 'untitled:Untitled-1', version: null },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({ exists: async () => false })
    })
    expect(plan.status).toBe('blocked')
    if (plan.status === 'blocked') {
      expect(plan.blocks.map((block) => block.reason)).toEqual([
        'missing-target',
        'out-of-scope',
        'non-file-uri'
      ])
    }
  })

  it('blocks overlapping or out-of-range text edits', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: null },
            edits: [
              edit({ sl: 0, sc: 0, el: 0, ec: 3 }, 'x'),
              edit({ sl: 0, sc: 1, el: 0, ec: 2 }, 'y')
            ]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({ readText: async () => 'abcdef\n' })
    })
    expect(plan.status).toBe('blocked')
    if (plan.status === 'blocked') {
      expect(plan.blocks[0]?.reason).toBe('edit-application')
    }
  })

  it('plans create/rename/delete resource operations', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          { kind: 'create', uri: 'file:///repo/src/new.py', options: { overwrite: false } },
          {
            kind: 'rename',
            oldUri: 'file:///repo/src/a.py',
            newUri: 'file:///repo/src/b.py',
            options: { overwrite: false }
          },
          { kind: 'delete', uri: 'file:///repo/src/c.py', options: { recursive: false } }
        ]
      } as WorkspaceEdit,
      scope,
      operationHostId: 'local',
      view: view({
        readText: async (path) =>
          ['a.py', 'c.py'].some((name) => path.endsWith(name)) ? 'content\n' : null,
        exists: async (path) => ['a.py', 'c.py'].some((name) => path.endsWith(name))
      })
    })
    expect(plan.status).toBe('planned')
    if (plan.status === 'planned') {
      expect(plan.steps.map((step) => step.type)).toEqual(['create', 'rename', 'delete'])
    }
  })

  it('blocks resource operations against wrong preconditions', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          { kind: 'create', uri: 'file:///repo/src/exists.py', options: { overwrite: false } },
          {
            kind: 'rename',
            oldUri: 'file:///repo/src/gone.py',
            newUri: 'file:///repo/src/b.py',
            options: { overwrite: false }
          },
          {
            kind: 'rename',
            oldUri: 'file:///repo/src/a.py',
            newUri: 'file:///repo/src/taken.py',
            options: { overwrite: false }
          },
          { kind: 'delete', uri: 'file:///repo/src/missing.py', options: {} }
        ]
      } as WorkspaceEdit,
      scope,
      operationHostId: 'local',
      view: view({ exists: async (path) => !path.includes('gone') && !path.includes('missing') })
    })
    expect(plan.status).toBe('blocked')
    if (plan.status === 'blocked') {
      expect(plan.blocks.map((block) => block.reason)).toEqual([
        'existing-target',
        'missing-target',
        'existing-target',
        'missing-target'
      ])
    }
  })

  it('blocks directory targets v1 cannot guard', async () => {
    const plan = await planWorkspaceEdit({
      edit: { changes: { 'file:///repo/src/pkg': [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')] } },
      scope,
      operationHostId: 'local',
      view: view({
        exists: async () => true,
        readText: async () => {
          throw new Error('EISDIR')
        }
      })
    })
    expect(plan.status).toBe('blocked')
    if (plan.status === 'blocked') {
      expect(plan.blocks[0]?.reason).toBe('unsupported-target')
    }
  })

  it('folds successive writes to the same document', async () => {
    const plan = await planWorkspaceEdit({
      edit: {
        documentChanges: [
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: null },
            edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'one ')]
          },
          {
            textDocument: { uri: 'file:///repo/src/a.py', version: null },
            edits: [edit({ sl: 0, sc: 4, el: 0, ec: 4 }, 'two')]
          }
        ]
      },
      scope,
      operationHostId: 'local',
      view: view({ readText: async () => 'x\n' })
    })
    expect(plan.status).toBe('planned')
    if (plan.status === 'planned') {
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]).toMatchObject({ nextContent: 'one twox\n' })
    }
  })
})

describe('applyWorkspaceTextEdits', () => {
  it('applies unsorted non-overlapping edits', () => {
    expect(
      applyWorkspaceTextEdits('abc\ndef\n', [
        edit({ sl: 1, sc: 1, el: 1, ec: 3 }, 'XY'),
        edit({ sl: 0, sc: 0, el: 0, ec: 1 }, 'A')
      ])
    ).toBe('Abc\ndXY\n')
  })
  it('rejects overlapping edits and out-of-range positions', () => {
    expect(applyWorkspaceTextEdits('abc', [edit({ sl: 0, sc: 1, el: 0, ec: 3 }, 'x'), edit({ sl: 0, sc: 2, el: 0, ec: 3 }, 'y')])).toBeNull()
    expect(applyWorkspaceTextEdits('abc', [edit({ sl: 5, sc: 0, el: 5, ec: 0 }, 'x')])).toBeNull()
    expect(applyWorkspaceTextEdits('abc', [edit({ sl: 0, sc: 0, el: 0, ec: 9 }, 'x')])).toBeNull()
  })
})
