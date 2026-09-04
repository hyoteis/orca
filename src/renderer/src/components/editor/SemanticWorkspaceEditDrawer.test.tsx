// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { SemanticWorkspaceEditDrawer } from './SemanticWorkspaceEditDrawer'
import {
  openSemanticEditDrawer,
  resetSemanticEditDrawerStore
} from '@/lib/language-server/semantic-workspace-edit-drawer-store'
import type { WorkspaceEditPlanView } from '@/lib/language-server/workspace-edit-plan'
import type { WorkspaceEditTransactionPorts } from '@/lib/language-server/workspace-edit-transaction'

const scope: CodeIntelligenceScope = {
  id: 'local:w:python',
  name: 'Python scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/repo',
  language: 'python',
  members: [{ path: '/repo/src', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

const replaceEdit = (paths: readonly string[], next: string): WorkspaceEdit => ({
  documentChanges: paths.map(
    (path) => ({
      textDocument: { uri: `file://${path}`, version: null },
      edits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          newText: next
        }
      ] as TextEdit[]
    })
  ) as WorkspaceEdit['documentChanges']
})

const openSession = (args: {
  edit: WorkspaceEdit
  files: Record<string, string>
  ports?: Partial<WorkspaceEditTransactionPorts>
}) => {
  const view: WorkspaceEditPlanView = {
    openDocumentFor: () => null,
    readText: async (path) => (path in args.files ? args.files[path] : null),
    exists: async (path) => path in args.files
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
    openDocumentFor: () => null,
    ...args.ports
  }
  return openSemanticEditDrawer({
    edit: args.edit,
    scope,
    operationHostId: 'local',
    view,
    ports,
    openFiles: [],
    worktreePathFor: () => null
  })
}

describe('SemanticWorkspaceEditDrawer', () => {
  beforeEach(() => {
    resetSemanticEditDrawerStore()
  })
  afterEach(() => {
    cleanup()
    resetSemanticEditDrawerStore()
  })

  it('renders nothing without a session', () => {
    const { container } = render(<SemanticWorkspaceEditDrawer />)
    expect(container.innerHTML).toBe('')
  })

  it('reviews planned steps with counts and the host/scope disclosure', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    openSession({ edit: replaceEdit(['/repo/src/a.py'], 'new text\n'), files })
    render(<SemanticWorkspaceEditDrawer />)
    await waitFor(() => {
      expect(screen.getByText('1 file operations')).toBeTruthy()
    })
    expect(screen.getByText('src/a.py')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    expect(screen.getByText('Execution host')).toBeTruthy()
    expect(screen.getByText('Scope')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('expands a write step diff on demand', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    openSession({ edit: replaceEdit(['/repo/src/a.py'], 'new text\n'), files })
    render(<SemanticWorkspaceEditDrawer />)
    await waitFor(() => {
      expect(screen.getByText('src/a.py')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('src/a.py'))
    expect(screen.getByText('+ new text')).toBeTruthy()
    expect(screen.getByText('− old text')).toBeTruthy()
  })

  it('shows blocked targets and re-checks into review', async () => {
    const files: Record<string, string> = {}
    openSession({ edit: replaceEdit(['/repo/src/a.py'], 'new text\n'), files })
    render(<SemanticWorkspaceEditDrawer />)
    await waitFor(() => {
      expect(screen.getByText('Target is missing')).toBeTruthy()
    })
    files['/repo/src/a.py'] = 'old text\n'
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    })
  })

  it('applies from review and offers undo', async () => {
    const files = { '/repo/src/a.py': 'old text\n' }
    const promise = openSession({ edit: replaceEdit(['/repo/src/a.py'], 'new text\n'), files })
    render(<SemanticWorkspaceEditDrawer />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(screen.getByText('Applied 1 file operation(s)')).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    // The sheet header also has a Close (X); the footer one is what we click.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    await expect(promise).resolves.toMatchObject({ kind: 'outcome' })
  })

  it('escalates an incomplete rollback to the recovery dialog', async () => {
    const files = { '/repo/src/a.py': 'old text\n', '/repo/src/b.py': 'old text\n' }
    let writes = 0
    openSession({
      edit: replaceEdit(['/repo/src/a.py', '/repo/src/b.py'], 'new text\n'),
      files,
      ports: {
        writeAtomic: async (path) => {
          writes += 1
          if (writes > 1) {
            throw new Error('disk full')
          }
          files[path] = 'new text\n'
        }
      }
    })
    render(<SemanticWorkspaceEditDrawer />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // The single write step commits, its rollback restore fails on write 2.
    await waitFor(() => {
      expect(screen.getByText('Some changes could not be rolled back')).toBeTruthy()
    })
    expect(screen.getByText('Not restored')).toBeTruthy()
    expect(screen.getByText('Recovery copies')).toBeTruthy()
  })
})
