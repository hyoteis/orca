import { describe, it, expect } from 'vitest'
import { groupSelectedBySubmoduleRoot, buildSubmoduleContext } from './source-control-submodule-stage-commit'
import type { FlatEntry } from './useSourceControlSelection'

const fe = (path: string, submoduleRoot?: string): FlatEntry => ({
  key: `${submoduleRoot ?? ''}::${path}`,
  area: 'unstaged',
  entry: { path, submoduleRoot, area: 'unstaged', status: 'M', added: 0, removed: 0 } as any
})

describe('groupSelectedBySubmoduleRoot', () => {
  it('splits parent and submodule groups', () => {
    const groups = groupSelectedBySubmoduleRoot([fe('root.txt'), fe('a.ts', 'sub'), fe('b.ts', 'sub')])
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
