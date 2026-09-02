// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { GlobalSettings, Repo } from '../../../../shared/types'

const openFile = vi.fn()
const setPendingEditorReveal = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ openFile, setPendingEditorReveal }),
    // findCodeIntelligenceScope reads state via param; getState only feeds open.
  }
}))

import {
  findCodeIntelligenceScope,
  openDefinitionTargetInWorkspace
} from './code-intelligence-workspace'

const repo: Repo = {
  id: 'demo',
  path: '/repo',
  displayName: 'demo',
  connectionId: null,
  executionHostId: 'local',
  kind: 'git',
  badgeColor: '#000000',
  addedAt: 1
}

const scope = (language: 'python' | 'cpp'): CodeIntelligenceScope => ({
  id: `local:worktree:demo:${language}`,
  name: `demo ${language}`,
  executionHostId: 'local',
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language,
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
})

const request = { filePath: '/repo/a.py', relativePath: 'a.py', worktreeId: 'demo' }

beforeEach(() => {
  openFile.mockClear()
  setPendingEditorReveal.mockClear()
})

describe('findCodeIntelligenceScope', () => {
  it('finds a python scope for a python document', () => {
    const settings = { codeIntelligenceScopes: [scope('python')] } as GlobalSettings
    const found = findCodeIntelligenceScope(request, 'python', { repos: [repo], settings })
    expect(found?.language).toBe('python')
  })

  it('does not match a cpp scope when python is requested', () => {
    const settings = { codeIntelligenceScopes: [scope('cpp')] } as GlobalSettings
    expect(findCodeIntelligenceScope(request, 'python', { repos: [repo], settings })).toBeNull()
  })

  it('skips scopes whose members exclude the document', () => {
    const narrow: CodeIntelligenceScope = {
      ...scope('python'),
      members: [{ path: 'pkg', visibleResults: true }]
    }
    const settings = { codeIntelligenceScopes: [narrow] } as GlobalSettings
    expect(findCodeIntelligenceScope(request, 'python', { repos: [repo], settings })).toBeNull()
  })
})

describe('openDefinitionTargetInWorkspace', () => {
  const target = {
    uri: 'file:///repo/b.py',
    range: {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 9 }
    }
  }

  it('opens in-workspace targets with a workspace-relative path', () => {
    expect(openDefinitionTargetInWorkspace(request, target, scope('python'))).toBe(true)
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/b.py', relativePath: 'b.py' }),
      expect.objectContaining({ focusEditor: true })
    )
  })

  it('opens external dependency targets labelled with the host path', () => {
    const external = { ...target, uri: 'file:///usr/lib/python3/site-packages/c.py' }
    expect(openDefinitionTargetInWorkspace(request, external, scope('python'))).toBe(true)
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/usr/lib/python3/site-packages/c.py',
        relativePath: '/usr/lib/python3/site-packages/c.py'
      }),
      expect.anything()
    )
  })

  it('rejects non-file uris', () => {
    expect(openDefinitionTargetInWorkspace(request, { ...target, uri: 'mailto:x' }, scope('python'))).toBe(
      false
    )
    expect(openFile).not.toHaveBeenCalled()
  })
})
