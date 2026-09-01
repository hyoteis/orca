import { describe, expect, it } from 'vitest'
import type {
  CodeIntelligenceLanguage,
  CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings } from '../../../../shared/types'
import {
  addCodeIntelligenceMembers,
  findCodeIntelligenceScopeForWorkspace,
  removeCodeIntelligenceMembers,
  setCodeIntelligenceMemberVisibility
} from './code-intelligence-scope-member-edit'

const scope = (members: CodeIntelligenceScope['members']): CodeIntelligenceScope => ({
  id: 'local:worktree:demo:cpp',
  name: 'demo C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members,
  serverSource: { type: 'custom', executable: 'clangd', args: [] },
  enabled: true,
  revision: 1
})

describe('addCodeIntelligenceMembers', () => {
  it('appends new members with visible results and skips exact duplicates', () => {
    const next = addCodeIntelligenceMembers(scope([{ path: 'engine', visibleResults: true }]), [
      'fx',
      'engine',
      'tools/cli'
    ])
    expect(next.members.map((member) => member.path)).toEqual(['engine', 'fx', 'tools/cli'])
    expect(next.members.every((member) => member.visibleResults)).toBe(true)
  })

  it('skips paths already governed by a containing member', () => {
    const input = scope([{ path: 'engine', visibleResults: true }])
    const next = addCodeIntelligenceMembers(input, ['engine/core'])
    expect(next).toBe(input)
  })

  it('normalizes member spellings and accepts host-absolute paths', () => {
    const next = addCodeIntelligenceMembers(scope([{ path: 'fx', visibleResults: true }]), [
      'engine\\core/',
      '/opt/sdk'
    ])
    expect(next.members.map((member) => member.path)).toEqual(['fx', 'engine/core', '/opt/sdk'])
  })

  it('skips a host-absolute path an absolute member already covers', () => {
    const input = scope([{ path: '/opt/sdk', visibleResults: true }])
    expect(addCodeIntelligenceMembers(input, ['/opt/sdk'])).toBe(input)
  })
})

describe('removeCodeIntelligenceMembers', () => {
  it('removes only exact member matches', () => {
    const next = removeCodeIntelligenceMembers(
      scope([
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: false },
        { path: 'engine/core', visibleResults: true }
      ]),
      ['engine', 'missing']
    )
    expect(next?.members.map((member) => member.path)).toEqual(['fx', 'engine/core'])
  })

  it('refuses to empty the scope', () => {
    expect(
      removeCodeIntelligenceMembers(scope([{ path: 'engine', visibleResults: true }]), ['engine'])
    ).toBeNull()
  })
})

describe('setCodeIntelligenceMemberVisibility', () => {
  it('flips exactly the targeted member', () => {
    const next = setCodeIntelligenceMemberVisibility(
      scope([
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: true }
      ]),
      'fx',
      false
    )
    expect(next.members.map((member) => member.visibleResults)).toEqual([true, false])
  })

  it('returns the input scope when the member is missing', () => {
    const input = scope([{ path: 'engine', visibleResults: true }])
    expect(setCodeIntelligenceMemberVisibility(input, 'fx', false)).toBe(input)
  })
})

describe('findCodeIntelligenceScopeForWorkspace', () => {
  const cpp = scope([{ path: '.', visibleResults: true }])
  const settings = (scopes: CodeIntelligenceScope[]) =>
    ({ codeIntelligenceScopes: scopes }) as GlobalSettings
  const query = (language: CodeIntelligenceLanguage, scopes: CodeIntelligenceScope[]) => ({
    settings: settings(scopes),
    repoId: 'demo',
    isFolder: false,
    executionHostId: 'local' as const,
    language
  })

  it('resolves the workspace scope triple', () => {
    expect(findCodeIntelligenceScopeForWorkspace(query('cpp', [cpp]))).toBe(cpp)
  })

  it('returns null for another language, host, workspace, or disabled scope', () => {
    const python = { ...cpp, id: 'local:worktree:demo:python', language: 'python' as const }
    expect(findCodeIntelligenceScopeForWorkspace(query('cpp', [python]))).toBeNull()
    expect(
      findCodeIntelligenceScopeForWorkspace({
        ...query('cpp', [cpp]),
        executionHostId: 'ssh:host-1'
      })
    ).toBeNull()
    expect(
      findCodeIntelligenceScopeForWorkspace({ ...query('cpp', [cpp]), isFolder: true })
    ).toBeNull()
    expect(
      findCodeIntelligenceScopeForWorkspace(query('cpp', [{ ...cpp, enabled: false }]))
    ).toBeNull()
  })
})
