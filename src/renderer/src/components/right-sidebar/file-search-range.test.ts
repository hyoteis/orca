import { describe, expect, it } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  filterRelativePathsByFileSearchScopeRange,
  getFileSearchRangeScopes,
  hasFileSearchScopeRangeMembers,
  isRelativePathInFileSearchScopeRange
} from './file-search-range'

const scope = (
  members: CodeIntelligenceScope['members'],
  overrides: Partial<CodeIntelligenceScope> = {}
): CodeIntelligenceScope => ({
  id: 'scope-1',
  name: 'Scope 1',
  executionHostId: 'local',
  workspaceKey: 'worktree:repo-1',
  workspaceRoot: '/workspace',
  language: 'python',
  members,
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1,
  ...overrides
})

describe('file search range scopes', () => {
  it('drops ssh-host scopes but keeps local and runtime ones', () => {
    const local = scope([])
    const runtime = scope([], { executionHostId: 'runtime:wsl' })
    const ssh = scope([], { executionHostId: 'ssh:conn-1' })
    expect(getFileSearchRangeScopes([local, runtime, ssh])).toEqual([local, runtime])
  })
})

describe('hasFileSearchScopeRangeMembers', () => {
  it('is false for empty scopes and out-of-tree members', () => {
    expect(hasFileSearchScopeRangeMembers([])).toBe(false)
    expect(hasFileSearchScopeRangeMembers([scope([])])).toBe(false)
    expect(
      hasFileSearchScopeRangeMembers([scope([{ path: '/opt/sdk', visibleResults: true }])])
    ).toBe(false)
  })

  it('is true for any in-tree member, false when only ssh scopes have members', () => {
    expect(hasFileSearchScopeRangeMembers([scope([{ path: 'engine', visibleResults: true }])])).toBe(
      true
    )
    const ssh = scope([{ path: 'engine', visibleResults: true }], {
      executionHostId: 'ssh:conn-1'
    })
    expect(hasFileSearchScopeRangeMembers([ssh])).toBe(false)
  })
})

describe('isRelativePathInFileSearchScopeRange', () => {
  it('unions members across language groups with directory-prefix matching', () => {
    const python = scope([{ path: 'engine/py', visibleResults: true }], { language: 'python' })
    const cpp = scope(
      [{ path: '/workspace/engine/cpp', visibleResults: true }],
      { id: 'scope-2', language: 'cpp' }
    )
    const range = [python, cpp]
    expect(isRelativePathInFileSearchScopeRange(range, 'engine/py/app.py')).toBe(true)
    expect(isRelativePathInFileSearchScopeRange(range, 'engine/cpp/main.cpp')).toBe(true)
    // Non-code files inside member dirs count — the range is a directory set.
    expect(isRelativePathInFileSearchScopeRange(range, 'engine/cpp/notes.txt')).toBe(true)
    expect(isRelativePathInFileSearchScopeRange(range, 'engine/fx/main.cpp')).toBe(false)
    expect(isRelativePathInFileSearchScopeRange(range, 'engine')).toBe(false)
  })

  it('never matches ssh or out-of-tree members', () => {
    const ssh = scope([{ path: 'engine', visibleResults: true }], {
      executionHostId: 'ssh:conn-1'
    })
    expect(isRelativePathInFileSearchScopeRange([ssh], 'engine/app.py')).toBe(false)
    const outOfTree = scope([{ path: '/opt/sdk', visibleResults: true }])
    expect(isRelativePathInFileSearchScopeRange([outOfTree], 'engine/app.py')).toBe(false)
  })
})

describe('filterRelativePathsByFileSearchScopeRange', () => {
  it('keeps only paths under unioned member dirs', () => {
    const scopes = [scope([{ path: 'engine/py', visibleResults: true }])]
    expect(
      filterRelativePathsByFileSearchScopeRange(
        ['engine/py/app.py', 'engine/fx/main.cpp', 'engine/py/nested/deep.ts'],
        scopes
      )
    ).toEqual(['engine/py/app.py', 'engine/py/nested/deep.ts'])
  })
})
