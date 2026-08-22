import { describe, expect, it, vi } from 'vitest'
import { CodeIntelligenceScopeCatalog } from './code-intelligence-scope-catalog'
import { discoverCodeIntelligenceCandidates } from './code-intelligence-scope-discovery'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
const scope: CodeIntelligenceScope = {
  id: 's',
  name: 'Scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  language: 'cpp',
  members: [{ relativePath: 'repo-a', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}
describe('CodeIntelligenceScopeCatalog', () => {
  it('persists normalized scopes and signals configuration restarts', async () => {
    const persist = vi.fn(),
      restart = vi.fn(),
      catalog = new CodeIntelligenceScopeCatalog([scope], persist)
    catalog.subscribeRestart(restart)
    await catalog.upsert({
      ...scope,
      members: [{ relativePath: 'repo-b/', visibleResults: true }],
      revision: 2
    })
    expect(persist).toHaveBeenCalled()
    expect(restart).toHaveBeenCalledWith('s')
    expect(catalog.list()[0].members[0].relativePath).toBe('repo-b')
    expect(catalog.list()[0].consent).toBeUndefined()
  })
  it('rejects member paths outside the workspace', () => {
    expect(
      () =>
        new CodeIntelligenceScopeCatalog(
          [{ ...scope, members: [{ relativePath: '../secret', visibleResults: true }] }],
          vi.fn()
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
