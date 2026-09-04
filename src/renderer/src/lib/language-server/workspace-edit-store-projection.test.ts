import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'
import type { OpenFile } from '@/store/slices/editor'
import {
  planWorkspaceEditProjection,
  projectCommittedWorkspaceEdit
} from './workspace-edit-store-projection'

const openFile = (filePath: string, overrides: Partial<OpenFile> = {}): OpenFile => ({
  id: filePath,
  filePath,
  relativePath: filePath.replace('/repo/', ''),
  worktreeId: 'w',
  language: 'python',
  isDirty: false,
  mode: 'edit',
  ...overrides
})

const writeStep = (hostPath: string, nextContent: string): WorkspaceEditPlannedStep => ({
  type: 'write',
  uri: `file://${hostPath}`,
  hostPath,
  baseContent: 'old',
  baseSignature: 'sig',
  nextContent,
  documentVersion: null
})

describe('planWorkspaceEditProjection', () => {
  it('derives self-writes, reload nudges, and remaps only for open files', () => {
    const projection = planWorkspaceEditProjection({
      steps: [
        writeStep('/repo/src/a.py', 'new-a'),
        { type: 'create', uri: 'file:///repo/src/new.py', hostPath: '/repo/src/new.py', overwrite: false },
        {
          type: 'rename',
          oldUri: 'file:///repo/src/b.py',
          newUri: 'file:///repo/src/c.py',
          oldHostPath: '/repo/src/b.py',
          newHostPath: '/repo/src/c.py',
          overwrite: false
        },
        { type: 'delete', uri: 'file:///repo/src/d.py', hostPath: '/repo/src/d.py' }
      ],
      openFiles: [openFile('/repo/src/a.py'), openFile('/repo/src/b.py')]
    })
    expect(projection).toEqual({
      selfWrites: [{ hostPath: '/repo/src/a.py', content: 'new-a' }],
      externalChanges: [
        { worktreeId: 'w', relativePath: 'src/a.py' },
        { worktreeId: 'w', relativePath: 'src/b.py' }
      ],
      remaps: [{ fromPath: '/repo/src/b.py', toPath: '/repo/src/c.py' }]
    })
  })
})

describe('projectCommittedWorkspaceEdit', () => {
  it('stamps self-writes before dispatching reloads and remaps', () => {
    const calls: string[] = []
    const recordSelfWrite = vi.fn((path: string) => calls.push(`self-write:${path}`))
    const remapOpenFiles = vi.fn(({ fromPath }: { fromPath: string }) =>
      calls.push(`remap:${fromPath}`)
    )
    const dispatch = vi.fn(() => calls.push('dispatch'))
    projectCommittedWorkspaceEdit({
      steps: [writeStep('/repo/src/a.py', 'new-a')],
      openFiles: [openFile('/repo/src/a.py')],
      worktreePathFor: () => '/repo',
      recordSelfWrite,
      remapOpenFiles,
      dispatch
    })
    expect(calls).toEqual(['self-write:/repo/src/a.py', 'dispatch'])
    expect(dispatch).toHaveBeenCalledWith({
      worktreeId: 'w',
      worktreePath: '/repo',
      relativePath: 'src/a.py'
    })
  })

  it('skips reload nudges for worktrees without a resolvable root', () => {
    const dispatch = vi.fn()
    projectCommittedWorkspaceEdit({
      steps: [writeStep('/repo/src/a.py', 'new-a')],
      openFiles: [openFile('/repo/src/a.py')],
      worktreePathFor: () => null,
      recordSelfWrite: () => {},
      dispatch
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
