import { describe, expect, it } from 'vitest'
import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'
import {
  runWorkspaceEditTransaction,
  type WorkspaceEditTransactionPorts
} from './workspace-edit-transaction'
import { getDiskBaselineSignature } from '../../components/editor/diff-content-signature'

const scope = {
  id: 'local:w:python',
  executionHostId: 'local' as const,
  workspaceRoot: '/repo',
  members: [{ path: '/repo/src', visibleResults: true }]
}

type Disk = Map<string, string>

type WriteStep = Extract<WorkspaceEditPlannedStep, { type: 'write' }>

function writeStep(hostPath: string, base: string, next: string): WriteStep {
  return {
    type: 'write',
    uri: `file://${hostPath}`,
    hostPath,
    baseContent: base,
    baseSignature: getDiskBaselineSignature(base),
    nextContent: next,
    documentVersion: null
  }
}

function createPorts(disk: Disk, events: string[] = []): WorkspaceEditTransactionPorts & {
  failNextWrite?: string
} {
  const ports: WorkspaceEditTransactionPorts & { failNextWrite?: string } = {
    failNextWrite: undefined,
    readText: async (path) => disk.get(path) ?? null,
    exists: async (path) => disk.has(path),
    writeAtomic: async (path, content) => {
      if (ports.failNextWrite === path) {
        ports.failNextWrite = undefined
        throw new Error('write failed')
      }
      events.push(`write:${path}`)
      disk.set(path, content)
    },
    createFile: async (path) => {
      events.push(`create:${path}`)
      disk.set(path, '')
    },
    renamePath: async (oldPath, newPath) => {
      events.push(`rename:${oldPath}->${newPath}`)
      const content = disk.get(oldPath)
      if (content === undefined) {
        throw new Error('rename source missing')
      }
      disk.delete(oldPath)
      disk.set(newPath, content)
    },
    deletePath: async (path) => {
      events.push(`delete:${path}`)
      disk.delete(path)
    },
    quiesceEditorSaves: async (paths) => {
      events.push(`quiesce:${[...paths].sort().join(',')}`)
    },
    openDocumentFor: () => null
  }
  return ports
}

describe('runWorkspaceEditTransaction', () => {
  it('commits every step and returns an inverse undo entry', async () => {
    const disk: Disk = new Map([
      ['/repo/src/a.py', 'old-a'],
      ['/repo/src/c.py', 'gone-soon']
    ])
    const ports = createPorts(disk)
    const outcome = await runWorkspaceEditTransaction({
      steps: [
        writeStep('/repo/src/a.py', 'old-a', 'new-a'),
        { type: 'create', uri: 'file:///repo/src/new.py', hostPath: '/repo/src/new.py', overwrite: false },
        {
          type: 'rename',
          oldUri: 'file:///repo/src/a.py',
          newUri: 'file:///repo/src/b.py',
          oldHostPath: '/repo/src/a.py',
          newHostPath: '/repo/src/b.py',
          overwrite: false
        },
        { type: 'delete', uri: 'file:///repo/src/c.py', hostPath: '/repo/src/c.py' }
      ],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('committed')
    if (outcome.status !== 'committed') {
      return
    }
    expect(outcome.steps.map((step) => step.type)).toEqual(['write', 'create', 'rename', 'delete'])
    expect([...disk.entries()].sort()).toEqual([
      ['/repo/src/b.py', 'new-a'],
      ['/repo/src/new.py', '']
    ])

    // The undo entry restores the pre-transaction state through the same engine.
    const undoPorts = createPorts(disk)
    const undoOutcome = await runWorkspaceEditTransaction({
      steps: outcome.undo.steps,
      scope,
      operationHostId: 'local',
      ports: undoPorts
    })
    expect(undoOutcome.status).toBe('committed')
    expect([...disk.entries()].sort()).toEqual([
      ['/repo/src/a.py', 'old-a'],
      ['/repo/src/c.py', 'gone-soon']
    ])
  })

  it('quiesces editor autosaves for all affected paths before reading preimages', async () => {
    const disk: Disk = new Map([['/repo/src/a.py', 'same']])
    const events: string[] = []
    const ports = createPorts(disk, events)
    const outcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'same', 'changed')],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('committed')
    expect(events).toEqual(['quiesce:/repo/src/a.py', 'write:/repo/src/a.py'])
  })

  it('blocks when the disk drifted from the planned base (external change)', async () => {
    const disk: Disk = new Map([['/repo/src/a.py', 'externally-rewritten']])
    const ports = createPorts(disk)
    const outcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'old-a', 'new-a')],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome).toEqual({
      status: 'blocked',
      blocks: [
        {
          uri: 'file:///repo/src/a.py',
          hostPath: '/repo/src/a.py',
          reason: 'external-change',
          detail: 'disk content differs from the planned base'
        }
      ]
    })
    expect(disk.get('/repo/src/a.py')).toBe('externally-rewritten')
  })

  it('blocks a dirty open editor and a stale synced version', async () => {
    const disk: Disk = new Map([['/repo/src/a.py', 'same']])
    const dirtyPorts = {
      ...createPorts(disk),
      openDocumentFor: () => ({ isDirty: true, syncedText: 'same', syncedVersion: 1 })
    }
    const dirty = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'same', 'next')],
      scope,
      operationHostId: 'local',
      ports: dirtyPorts
    })
    expect(dirty.status).toBe('blocked')
    if (dirty.status === 'blocked') {
      expect(dirty.blocks[0]?.reason).toBe('dirty-editor')
    }

    const stalePorts = {
      ...createPorts(new Map([['/repo/src/a.py', 'same']])),
      openDocumentFor: () => ({ isDirty: false, syncedText: 'same', syncedVersion: 7 })
    }
    const stale = await runWorkspaceEditTransaction({
      steps: [{ ...writeStep('/repo/src/a.py', 'same', 'next'), documentVersion: 3 }],
      scope,
      operationHostId: 'local',
      ports: stalePorts
    })
    expect(stale.status).toBe('blocked')
    if (stale.status === 'blocked') {
      expect(stale.blocks[0]?.reason).toBe('stale-version')
    }
  })

  it('blocks out-of-scope and host-mismatched steps before any write', async () => {
    const disk: Disk = new Map([['/repo/vendor/a.py', 'x']])
    const ports = createPorts(disk)
    const outcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/vendor/a.py', 'x', 'y')],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('blocked')
    const sshOutcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'x', 'y')],
      scope,
      operationHostId: 'ssh:elsewhere',
      ports
    })
    expect(sshOutcome.status).toBe('blocked')
    expect(disk.get('/repo/vendor/a.py')).toBe('x')
  })

  it('rolls back completed steps when a later step fails', async () => {
    const disk: Disk = new Map([
      ['/repo/src/a.py', 'old-a'],
      ['/repo/src/b.py', 'old-b']
    ])
    const ports = createPorts(disk)
    ports.failNextWrite = '/repo/src/b.py'
    const outcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'old-a', 'new-a'), writeStep('/repo/src/b.py', 'old-b', 'new-b')],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') {
      return
    }
    expect(outcome.rolledBack).toBe(true)
    expect(outcome.steps).toEqual([
      { hostPath: '/repo/src/a.py', type: 'write', status: 'rolled-back' }
    ])
    expect([...disk.entries()].sort()).toEqual([
      ['/repo/src/a.py', 'old-a'],
      ['/repo/src/b.py', 'old-b']
    ])
  })

  it('emits a recovery artifact when the rollback itself fails', async () => {
    const disk: Disk = new Map([
      ['/repo/src/a.py', 'old-a'],
      ['/repo/src/b.py', 'old-b']
    ])
    const ports = createPorts(disk)
    // First failing write is the forward b.py commit; the rollback write for
    // a.py then fails too, leaving a.py stranded on new-a.
    let failures = 0
    const originalWrite = ports.writeAtomic.bind(ports)
    ports.writeAtomic = async (path, content) => {
      if (path === '/repo/src/b.py') {
        throw new Error('commit failed')
      }
      if (path === '/repo/src/a.py' && failures++ === 0) {
        return originalWrite(path, content)
      }
      if (path === '/repo/src/a.py') {
        throw new Error('rollback failed')
      }
      return originalWrite(path, content)
    }
    const outcome = await runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'old-a', 'new-a'), writeStep('/repo/src/b.py', 'old-b', 'new-b')],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') {
      return
    }
    expect(outcome.rolledBack).toBe(false)
    expect(outcome.recovery.entries).toEqual([
      { hostPath: '/repo/src/a.py', kind: 'content', content: 'old-a' }
    ])
    expect(disk.get('/repo/src/a.py')).toBe('new-a')
  })

  it('undoes an overwrite rename including the clobbered destination', async () => {
    const disk: Disk = new Map([
      ['/repo/src/a.py', 'a-content'],
      ['/repo/src/b.py', 'b-content']
    ])
    const ports = createPorts(disk)
    const outcome = await runWorkspaceEditTransaction({
      steps: [
        {
          type: 'rename',
          oldUri: 'file:///repo/src/a.py',
          newUri: 'file:///repo/src/b.py',
          oldHostPath: '/repo/src/a.py',
          newHostPath: '/repo/src/b.py',
          overwrite: true
        }
      ],
      scope,
      operationHostId: 'local',
      ports
    })
    expect(outcome.status).toBe('committed')
    expect([...disk.entries()].sort()).toEqual([['/repo/src/b.py', 'a-content']])

    const undoPorts = createPorts(disk)
    const undo = await runWorkspaceEditTransaction({
      steps: outcome.status === 'committed' ? outcome.undo.steps : [],
      scope,
      operationHostId: 'local',
      ports: undoPorts
    })
    expect(undo.status).toBe('committed')
    expect([...disk.entries()].sort()).toEqual([
      ['/repo/src/a.py', 'a-content'],
      ['/repo/src/b.py', 'b-content']
    ])
  })

  it('serializes concurrent transactions through one queue', async () => {
    const disk: Disk = new Map([['/repo/src/a.py', 'a']])
    const ports = createPorts(disk)
    const first = runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'a', 'b')],
      scope,
      operationHostId: 'local',
      ports
    })
    const second = runWorkspaceEditTransaction({
      steps: [writeStep('/repo/src/a.py', 'a', 'c')],
      scope,
      operationHostId: 'local',
      ports
    })
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    const statuses = [firstOutcome.status, secondOutcome.status].sort()
    expect(statuses).toEqual(['blocked', 'committed'])
  })
})
