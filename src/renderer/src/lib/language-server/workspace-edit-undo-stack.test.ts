import { describe, expect, it } from 'vitest'
import type { WorkspaceEditUndoEntry } from '../../../../shared/language-server-workspace-edit'
import {
  WorkspaceEditUndoStack,
  undoLatestWorkspaceEdit
} from './workspace-edit-undo-stack'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'
import { getDiskBaselineSignature } from '../../components/editor/diff-content-signature'

const scope = {
  id: 'local:w:python',
  executionHostId: 'local' as const,
  workspaceRoot: '/repo',
  members: [{ path: '/repo/src', visibleResults: true }]
}

const entry = (createdAt: number): WorkspaceEditUndoEntry => ({
  scope: { ...scope },
  createdAt,
  steps: [
    {
      type: 'write',
      uri: 'file:///repo/src/a.py',
      hostPath: '/repo/src/a.py',
      baseContent: 'current',
      baseSignature: getDiskBaselineSignature('current'),
      nextContent: 'restored',
      documentVersion: null
    }
  ]
})

function ports(disk: Map<string, string>): WorkspaceEditTransactionPorts {
  return {
    readText: async (path) => disk.get(path) ?? null,
    exists: async (path) => disk.has(path),
    writeAtomic: async (path, content) => {
      disk.set(path, content)
    },
    createFile: async (path) => {
      disk.set(path, '')
    },
    renamePath: async (from, to) => {
      disk.set(to, disk.get(from) ?? '')
      disk.delete(from)
    },
    deletePath: async (path) => {
      disk.delete(path)
    },
    quiesceEditorSaves: async () => {},
    openDocumentFor: () => null
  }
}

describe('WorkspaceEditUndoStack', () => {
  it('pushes, pops newest-first, and caps the history', () => {
    const stack = new WorkspaceEditUndoStack(2)
    stack.push(entry(1))
    stack.push(entry(2))
    stack.push(entry(3))
    expect(stack.size).toBe(2)
    expect(stack.latest?.createdAt).toBe(3)
    expect(stack.pop()?.createdAt).toBe(3)
    expect(stack.pop()?.createdAt).toBe(2)
    expect(stack.pop()).toBeNull()
  })
})

describe('undoLatestWorkspaceEdit', () => {
  it('runs the inverse, pushes redo on success, and keeps the entry on failure', async () => {
    const disk = new Map([['/repo/src/a.py', 'current']])
    const stack = new WorkspaceEditUndoStack()
    stack.push(entry(1))
    const outcome = await undoLatestWorkspaceEdit({ ports: ports(disk), stack })
    expect(outcome?.status).toBe('committed')
    expect(disk.get('/repo/src/a.py')).toBe('restored')
    // Committed undo leaves its own inverse behind (redo).
    expect(stack.size).toBe(1)
    expect(stack.latest?.steps[0]).toMatchObject({ nextContent: 'current' })

    // A blocked undo (disk drifted) keeps the entry for retry.
    const drifted = new Map([['/repo/src/a.py', 'touched-externally']])
    const blocked = await undoLatestWorkspaceEdit({ ports: ports(drifted), stack })
    expect(blocked?.status).toBe('blocked')
    expect(stack.size).toBe(1)
    expect(stack.latest?.steps[0]).toMatchObject({ nextContent: 'current' })
  })

  it('returns null when the session has no undo history', async () => {
    const outcome = await undoLatestWorkspaceEdit({
      ports: ports(new Map()),
      stack: new WorkspaceEditUndoStack()
    })
    expect(outcome).toBeNull()
  })

  it('redoes a recreated file with a delete, not an empty write', async () => {
    const disk = new Map<string, string>()
    const stack = new WorkspaceEditUndoStack()
    stack.push({
      scope: { ...scope },
      createdAt: 1,
      steps: [
        {
          type: 'write',
          uri: 'file:///repo/src/a.py',
          hostPath: '/repo/src/a.py',
          baseContent: null,
          baseSignature: '',
          nextContent: 'restored',
          documentVersion: null
        }
      ]
    })
    const outcome = await undoLatestWorkspaceEdit({ ports: ports(disk), stack })
    expect(outcome?.status).toBe('committed')
    expect(disk.get('/repo/src/a.py')).toBe('restored')
    expect(stack.latest?.steps).toEqual([
      { type: 'delete', uri: 'file:///repo/src/a.py', hostPath: '/repo/src/a.py' }
    ])
  })
})
