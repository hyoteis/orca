import { describe, it, expect } from 'vitest'
import {
  groupSelectedBySubmoduleRoot,
  buildSubmoduleContext,
  planBulkStageContexts
} from './source-control-submodule-stage-commit'
import type { FlatEntry } from './useSourceControlSelection'
import type { RuntimeGitContext } from '../../runtime/runtime-git-client'

const fe = (path: string, submoduleRoot?: string): FlatEntry => ({
  key: `${submoduleRoot ?? ''}::${path}`,
  area: 'unstaged',
  entry: { path, submoduleRoot, area: 'unstaged', status: 'M', added: 0, removed: 0 } as any
})

const parentCtx: RuntimeGitContext = {
  settings: null,
  worktreeId: 'wt-1',
  worktreePath: '/repo/wt',
  connectionId: 'c1'
}

describe('groupSelectedBySubmoduleRoot', () => {
  it('splits parent and submodule groups', () => {
    const groups = groupSelectedBySubmoduleRoot([fe('root.txt'), fe('sub/a.ts', 'sub'), fe('sub/b.ts', 'sub')])
    expect([...groups.keys()].sort()).toEqual([null, 'sub'])
    expect(groups.get(null)).toEqual(['root.txt'])
    expect(groups.get('sub')).toEqual(['a.ts', 'b.ts'])
  })
})

describe('buildSubmoduleContext', () => {
  it('joins parent path with submodule root and nulls worktreeId for the local branch', () => {
    const ctx = buildSubmoduleContext({ settings: null, worktreeId: 'w', worktreePath: '/repo', connectionId: 'c' }, 'vendor/sub')
    expect(ctx.worktreePath.replace(/\\/g, '/')).toBe('/repo/vendor/sub')
    expect(ctx.worktreeId).toBeNull()
    expect(ctx.connectionId).toBe('c')
  })
})

describe('planBulkStageContexts', () => {
  it('plans a parent call and a submodule call when selection spans both', () => {
    const plan = planBulkStageContexts(
      [fe('root.txt'), fe('sub/a.ts', 'sub'), fe('sub/b.ts', 'sub')],
      parentCtx
    )
    expect(plan).toHaveLength(2)
    const parent = plan.find((p) => p.context.worktreeId === 'wt-1')
    const sub = plan.find((p) => p.context.worktreeId === null)
    expect(parent?.paths).toEqual(['root.txt'])
    expect(parent?.context).toBe(parentCtx)
    expect(sub?.paths).toEqual(['a.ts', 'b.ts'])
    expect(sub?.context.worktreePath.replace(/\\/g, '/')).toBe('/repo/wt/sub')
    expect(sub?.context.connectionId).toBe('c1')
  })

  it('plans only a parent call when selection is parent-only', () => {
    const plan = planBulkStageContexts([fe('root.txt'), fe('other.txt')], parentCtx)
    expect(plan).toHaveLength(1)
    expect(plan[0].paths).toEqual(['root.txt', 'other.txt'])
    expect(plan[0].context).toBe(parentCtx)
  })
})
