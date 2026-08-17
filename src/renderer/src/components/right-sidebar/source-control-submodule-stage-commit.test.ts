import { describe, it, expect, vi } from 'vitest'
import {
  groupSelectedBySubmoduleRoot,
  buildSubmoduleContext,
  planBulkStageContexts,
  commitSelectedAcrossSubmoduleRoots
} from './source-control-submodule-stage-commit'
import type { FlatEntry } from './useSourceControlSelection'
import type { RuntimeGitContext } from '../../runtime/runtime-git-client'

const fe = (path: string, submoduleRoot?: string): FlatEntry => ({
  key: `${submoduleRoot ?? ''}::${path}`,
  area: 'unstaged',
  entry: { path, submoduleRoot, area: 'unstaged', status: 'M', added: 0, removed: 0 } as any
})

const stagedFe = (path: string, submoduleRoot?: string): FlatEntry => ({
  key: `${submoduleRoot ?? ''}::${path}`,
  area: 'staged',
  entry: { path, submoduleRoot, area: 'staged', status: 'M', added: 0, removed: 0 } as any
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

describe('commitSelectedAcrossSubmoduleRoots', () => {
  it('commits parent and each submodule root once with the same message', async () => {
    const calls: { ctx: RuntimeGitContext; message: string }[] = []
    const commit = vi.fn(async (ctx: RuntimeGitContext, message: string) => {
      calls.push({ ctx, message })
      return { success: true }
    })

    const { failures, success } = await commitSelectedAcrossSubmoduleRoots(
      [stagedFe('root.txt'), stagedFe('sub/a.ts', 'sub'), stagedFe('sub/b.ts', 'sub')],
      parentCtx,
      commit,
      'feat: x'
    )

    expect(success).toBe(true)
    expect(failures).toEqual([])
    expect(commit).toHaveBeenCalledTimes(2)
    // parent group committed with parent ctx, submodule group with submodule ctx
    const parentCall = calls.find((c) => c.ctx.worktreeId === 'wt-1')
    const subCall = calls.find((c) => c.ctx.worktreeId === null)
    expect(parentCall).toBeDefined()
    expect(parentCall?.ctx).toBe(parentCtx)
    expect(parentCall?.message).toBe('feat: x')
    expect(subCall).toBeDefined()
    expect(subCall?.ctx.worktreePath.replace(/\\/g, '/')).toBe('/repo/wt/sub')
    expect(subCall?.message).toBe('feat: x')
  })

  it('does not abort the parent commit when a submodule fails, and collects the failure', async () => {
    const calls: { ctx: RuntimeGitContext }[] = []
    const commit = vi.fn(async (ctx: RuntimeGitContext) => {
      calls.push({ ctx })
      // Why: the submodule (null worktreeId) fails; the parent must still be committed.
      return ctx.worktreeId === null
        ? { success: false, error: 'submodule hook failure' }
        : { success: true }
    })

    const { failures, success } = await commitSelectedAcrossSubmoduleRoots(
      [stagedFe('root.txt'), stagedFe('sub/a.ts', 'sub')],
      parentCtx,
      commit,
      'feat: x'
    )

    expect(success).toBe(false)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(calls.some((c) => c.ctx.worktreeId === 'wt-1')).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0].root).toBe('sub')
    expect(failures[0].error).toBe('submodule hook failure')
  })

  it('falls back to a single parent commit when nothing is selected', async () => {
    const commit = vi.fn(async () => ({ success: true }))

    const { success } = await commitSelectedAcrossSubmoduleRoots([], parentCtx, commit, 'feat: x')

    expect(success).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    const firstCallCtx = (commit.mock.calls[0] as unknown as [RuntimeGitContext])[0]
    expect(firstCallCtx).toBe(parentCtx)
  })
})
