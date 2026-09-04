import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { OpenFile } from '@/store/slices/editor'
import {
  applySemanticEditDrawerReview,
  closeSemanticEditDrawer,
  openSemanticEditDrawer,
  refreshSemanticEditDrawer,
  resetSemanticEditDrawerStore,
  semanticWorkspaceEditDrawerStore,
  undoSemanticEditDrawerCompletion
} from './semantic-workspace-edit-drawer-store'
import { WorkspaceEditUndoStack } from './workspace-edit-undo-stack'
import type { WorkspaceEditPlanView } from './workspace-edit-plan'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'
import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'

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

const replaceEdit = (paths: readonly string[]): WorkspaceEdit => ({
  documentChanges: paths.map((path) => ({
    textDocument: { uri: `file://${path}`, version: null },
    edits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'x = 1\n'
      }
    ] as TextEdit[]
  })) as WorkspaceEdit['documentChanges']
})

const openFiles: OpenFile[] = []

/** Shared disk world: view and ports read/write the same file map. */
const openSession = (args: {
  edit: WorkspaceEdit
  files: Record<string, string>
  ports?: Partial<WorkspaceEditTransactionPorts>
  stack?: WorkspaceEditUndoStack
}) => {
  const dirty = new Set<string>()
  const openDocumentFor = (path: string) =>
    dirty.has(path) ? { isDirty: true, syncedText: null, syncedVersion: null } : null
  const view: WorkspaceEditPlanView & { setOpenDirty: (path: string) => void } = {
    openDocumentFor,
    readText: async (path) => (path in args.files ? args.files[path] : null),
    exists: async (path) => path in args.files,
    setOpenDirty: (path) => dirty.add(path)
  }
  const ports: WorkspaceEditTransactionPorts = {
    readText: async (path) => (path in args.files ? args.files[path] : null),
    exists: async (path) => path in args.files,
    writeAtomic: async (path, content) => {
      args.files[path] = content
    },
    createFile: vi.fn(async () => undefined),
    renamePath: vi.fn(async () => undefined),
    deletePath: vi.fn(async () => undefined),
    quiesceEditorSaves: vi.fn(async () => undefined),
    openDocumentFor,
    ...args.ports
  }
  const promise = openSemanticEditDrawer({
    edit: args.edit,
    scope,
    operationHostId: 'local',
    view,
    ports,
    stack: args.stack,
    openFiles,
    worktreePathFor: () => null
  })
  return { promise, view }
}

const phaseKind = (): string | null => semanticWorkspaceEditDrawerStore.getState().phase?.kind ?? null

const waitForPhase = async (kind: string): Promise<void> => {
  await vi.waitFor(() => {
    expect(phaseKind()).toBe(kind)
  })
}

describe('semantic workspace-edit drawer store', () => {
  beforeEach(() => {
    resetSemanticEditDrawerStore()
  })

  it('plans into review on open and keeps the promise pending', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const { promise } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    const phase = semanticWorkspaceEditDrawerStore.getState().phase
    expect(
      (phase as { steps: readonly WorkspaceEditPlannedStep[] }).steps
    ).toMatchObject([{ type: 'write', hostPath: '/repo/src/a.py' }])
    expect(promise).toBeInstanceOf(Promise)
    void promise
  })

  it('shows conflicts for a blocked plan and refresh re-plans into review', async () => {
    const files: Record<string, string> = {}
    openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('conflicts')
    expect(
      semanticWorkspaceEditDrawerStore.getState().phase
    ).toMatchObject({ kind: 'conflicts', blocks: [{ reason: 'missing-target' }] })
    files['/repo/src/a.py'] = 'old text\n'
    await refreshSemanticEditDrawer()
    await waitForPhase('review')
  })

  it('apply commits, records undo, and resolves with the outcome', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const stack = new WorkspaceEditUndoStack()
    const { promise } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files, stack })
    await waitForPhase('review')
    await applySemanticEditDrawerReview()
    await waitForPhase('done')
    expect(stack.size).toBe(1)
    await expect(promise).resolves.toMatchObject({
      kind: 'outcome',
      outcome: { status: 'committed' }
    })
  })

  it('apply failure with full rollback ends done and resolves', async () => {
    const files = { '/repo/src/a.py': 'old text\n', '/repo/src/b.py': 'old text\n' }
    const { promise } = openSession({
      edit: replaceEdit(['/repo/src/a.py', '/repo/src/b.py']),
      files,
      ports: {
        writeAtomic: async () => {
          throw new Error('disk full')
        }
      }
    })
    await waitForPhase('review')
    await applySemanticEditDrawerReview()
    await waitForPhase('done')
    const outcome = (
      semanticWorkspaceEditDrawerStore.getState().phase as {
        outcome: { status: string }
      }
    ).outcome
    expect(outcome.status).toBe('failed')
    await expect(promise).resolves.toMatchObject({
      kind: 'outcome',
      outcome: { status: 'failed', rolledBack: true }
    })
  })

  it('incomplete rollback escalates to recovery and resolves with the artifact', async () => {
    const files = { '/repo/src/a.py': 'old text\n', '/repo/src/b.py': 'old text\n' }
    let writes = 0
    const { promise } = openSession({
      edit: replaceEdit(['/repo/src/a.py', '/repo/src/b.py']),
      files,
      ports: {
        writeAtomic: async () => {
          writes += 1
          if (writes > 1) {
            throw new Error('disk full')
          }
          files['/repo/src/a.py'] = 'x = 1\nold text\n'
        }
      }
    })
    await waitForPhase('review')
    await applySemanticEditDrawerReview()
    await waitForPhase('recovery')
    const phase = semanticWorkspaceEditDrawerStore.getState().phase as {
      outcome: { recovery: { entries: unknown[] } }
    }
    expect(phase.outcome.recovery.entries.length).toBeGreaterThan(0)
    await expect(promise).resolves.toMatchObject({
      kind: 'outcome',
      outcome: { status: 'failed', rolledBack: false }
    })
  })

  it('a revalidation race blocks into conflicts without resolving', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const { promise, view } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    view.setOpenDirty('/repo/src/a.py')
    await applySemanticEditDrawerReview()
    await waitForPhase('conflicts')
    let resolved = false
    void promise.then(() => {
      resolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBe(false)
  })

  it('close at review resolves cancelled and clears the session', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const { promise } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    await closeSemanticEditDrawer()
    await expect(promise).resolves.toEqual({ kind: 'cancelled' })
    expect(semanticWorkspaceEditDrawerStore.getState().session).toBeNull()
  })

  it('close while applying is ignored', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    const applying = applySemanticEditDrawerReview()
    await waitForPhase('applying')
    await closeSemanticEditDrawer()
    expect(phaseKind()).toBe('applying')
    await applying
    await waitForPhase('done')
  })

  it('undo from done runs the inverse and reports its outcome', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const stack = new WorkspaceEditUndoStack()
    const { promise } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files, stack })
    await waitForPhase('review')
    await applySemanticEditDrawerReview()
    await waitForPhase('done')
    await undoSemanticEditDrawerCompletion()
    await waitForPhase('done')
    const state = semanticWorkspaceEditDrawerStore.getState()
    expect(stack.size).toBe(1) // redo entry pushed back
    expect(state.phase).toMatchObject({ kind: 'done', outcome: { status: 'committed' } })
    await expect(promise).resolves.toMatchObject({ kind: 'outcome' })
  })

  it('close from done clears the session without touching the resolved promise', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const { promise } = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    await applySemanticEditDrawerReview()
    await waitForPhase('done')
    await closeSemanticEditDrawer()
    expect(semanticWorkspaceEditDrawerStore.getState().session).toBeNull()
    await expect(promise).resolves.toMatchObject({ kind: 'outcome' })
  })

  it('a superseding open resolves the first session as cancelled', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const first = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await waitForPhase('review')
    const second = openSession({ edit: replaceEdit(['/repo/src/a.py']), files })
    await expect(first.promise).resolves.toEqual({ kind: 'cancelled' })
    await waitForPhase('review')
    await closeSemanticEditDrawer()
    await expect(second.promise).resolves.toEqual({ kind: 'cancelled' })
  })
})
