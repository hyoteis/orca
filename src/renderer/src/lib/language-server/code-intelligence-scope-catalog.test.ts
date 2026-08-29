import { describe, expect, it, vi } from 'vitest'
import { CodeIntelligenceScopeCatalog } from './code-intelligence-scope-catalog'
import { discoverCodeIntelligenceCandidates } from './code-intelligence-scope-discovery'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
const scope: CodeIntelligenceScope = {
  id: 's',
  name: 'Scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members: [{ path: 'repo-a', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}
describe('CodeIntelligenceScopeCatalog', () => {
  it('persists normalized scopes and signals configuration restarts', async () => {
    const persistence = {
        upsert: vi.fn(async (next: CodeIntelligenceScope) => next),
        remove: vi.fn(async () => true)
      },
      restart = vi.fn(),
      catalog = new CodeIntelligenceScopeCatalog([scope], persistence)
    catalog.subscribeRestart(restart)
    await catalog.upsert({
      ...scope,
      members: [{ path: 'repo-b/', visibleResults: true }],
      revision: 2
    })
    expect(persistence.upsert).toHaveBeenCalled()
    expect(restart).toHaveBeenCalledWith('s')
    expect(catalog.list()[0].members[0].path).toBe('repo-b')
    expect(catalog.list()[0].consent).toBeUndefined()
  })
  it('preserves paths that differ only by case for case-sensitive Hosts', () => {
    const catalog = new CodeIntelligenceScopeCatalog(
      [
        {
          ...scope,
          members: [
            { path: 'Src', visibleResults: true },
            { path: 'src', visibleResults: true }
          ]
        }
      ],
      { upsert: vi.fn(), remove: vi.fn() }
    )
    expect(catalog.list()[0].members).toHaveLength(2)
  })

  it('rejects member paths outside the workspace', () => {
    expect(
      () =>
        new CodeIntelligenceScopeCatalog(
          [{ ...scope, members: [{ path: '../secret', visibleResults: true }] }],
          { upsert: vi.fn(), remove: vi.fn() }
        )
    ).toThrow('stay inside')
  })
})
describe('discovery', () => {
  it('groups bilingual setup candidates without modifying files', () => {
    expect(
      discoverCodeIntelligenceCandidates([
        'repo-a/pyproject.toml',
        'repo-b/CMakeLists.txt',
        'repo-b/compile_commands.json'
      ])
    ).toEqual([
      { relativeRoot: 'repo-a', languages: ['python'], markers: ['pyproject.toml'] },
      {
        relativeRoot: 'repo-b',
        languages: ['cpp'],
        markers: ['CMakeLists.txt', 'compile_commands.json']
      }
    ])
  })
})
