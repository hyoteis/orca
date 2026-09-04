import { describe, expect, it } from 'vitest'
import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'
import { buildWorkspaceEditStepPreviews, diffLines } from './workspace-edit-step-preview'

const writeStep = (overrides: Partial<Extract<WorkspaceEditPlannedStep, { type: 'write' }>> = {}) =>
  ({
    type: 'write',
    uri: 'file:///repo/src/a.py',
    hostPath: '/repo/src/a.py',
    baseContent: 'one\ntwo\nthree\n',
    baseSignature: 'sig',
    nextContent: 'one\ntwo changed\nthree\nfour\n',
    documentVersion: null,
    ...overrides
  }) as WorkspaceEditPlannedStep

describe('diffLines', () => {
  it('marks changed lines as remove+add and keeps context', () => {
    const rows = diffLines('one\ntwo\nthree\n', 'one\ntwo changed\nthree\n')
    expect(rows).toEqual([
      { kind: 'context', text: 'one' },
      { kind: 'remove', text: 'two' },
      { kind: 'add', text: 'two changed' },
      { kind: 'context', text: 'three' }
    ])
  })

  it('treats an empty base as a pure addition', () => {
    expect(diffLines('', 'a\nb\n')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' }
    ])
  })

  it('collapses long unchanged runs to a marker', () => {
    const before = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`
    const rows = diffLines(before, before)
    expect(rows.filter((row) => row.text === '…')).toHaveLength(1)
    expect(rows[0]).toEqual({ kind: 'context', text: 'line 0' })
    expect(rows.at(-1)).toEqual({ kind: 'context', text: 'line 19' })
  })

  it('degrades to whole-file replace past the line cap', () => {
    const big = `${Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n')}\n`
    const rows = diffLines(big, 'changed\n')
    expect(rows).toHaveLength(2002)
    expect(rows[0]).toEqual({ kind: 'remove', text: 'line 0' })
    expect(rows.at(-1)).toEqual({ kind: 'add', text: 'changed' })
  })
})

describe('buildWorkspaceEditStepPreviews', () => {
  it('relativizes write paths against the workspace root and counts added/removed lines', () => {
    const [row] = buildWorkspaceEditStepPreviews({
      steps: [writeStep()],
      workspaceRoot: '/repo'
    })
    expect(row).toMatchObject({ type: 'write', path: 'src/a.py', addLines: 2, removeLines: 1 })
    expect(row?.diff).not.toBeNull()
  })

  it('relativizes Windows host paths case-insensitively', () => {
    const [row] = buildWorkspaceEditStepPreviews({
      steps: [writeStep({ hostPath: 'C:\\Repo\\src\\a.py' })],
      workspaceRoot: 'c:\\repo'
    })
    expect(row?.path).toBe('src/a.py')
  })

  it('keeps paths outside the root intact', () => {
    const [row] = buildWorkspaceEditStepPreviews({
      steps: [writeStep({ hostPath: '/elsewhere/a.py' })],
      workspaceRoot: '/repo'
    })
    expect(row?.path).toBe('/elsewhere/a.py')
  })

  it('models rename, create, and delete steps without diffs', () => {
    const rows = buildWorkspaceEditStepPreviews({
      steps: [
        {
          type: 'rename',
          oldUri: 'file:///repo/src/a.py',
          newUri: 'file:///repo/src/b.py',
          oldHostPath: '/repo/src/a.py',
          newHostPath: '/repo/src/b.py',
          overwrite: false
        },
        { type: 'create', uri: 'file:///repo/src/new.py', hostPath: '/repo/src/new.py', overwrite: false },
        { type: 'delete', uri: 'file:///repo/src/gone.py', hostPath: '/repo/src/gone.py' }
      ],
      workspaceRoot: '/repo'
    })
    expect(rows[0]).toMatchObject({ type: 'rename', path: 'src/a.py', nextPath: 'src/b.py', diff: null })
    expect(rows[1]).toMatchObject({ type: 'create', path: 'src/new.py', overwrite: false, diff: null })
    expect(rows[2]).toMatchObject({ type: 'delete', path: 'src/gone.py', diff: null })
  })

  it('diffs a recreated file (null base) as pure additions', () => {
    const [row] = buildWorkspaceEditStepPreviews({
      steps: [writeStep({ baseContent: null })],
      workspaceRoot: '/repo'
    })
    expect(row?.addLines).toBe(4)
    expect(row?.removeLines).toBe(0)
  })
})
