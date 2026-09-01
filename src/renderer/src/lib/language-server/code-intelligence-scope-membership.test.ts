import { describe, expect, it } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  getCodeIntelligenceMembershipAction,
  isCodeIntelligenceResultVisible,
  isDocumentInCodeIntelligenceScope
} from './code-intelligence-scope-membership'

const scope = (
  members: CodeIntelligenceScope['members'],
  workspaceRoot = '/workspace'
): Pick<CodeIntelligenceScope, 'workspaceRoot' | 'members'> => ({ workspaceRoot, members })

describe('code intelligence scope membership', () => {
  it('matches documents under absolute members inside the workspace root', () => {
    const mixed = scope([{ path: '/workspace/engine', visibleResults: true }])
    expect(isDocumentInCodeIntelligenceScope(mixed, 'engine/core/main.cpp')).toBe(true)
    expect(isDocumentInCodeIntelligenceScope(mixed, 'fx/main.cpp')).toBe(false)
  })

  it('never matches workspace documents against absolute members outside the root', () => {
    const external = scope([{ path: '/opt/sdk', visibleResults: true }])
    expect(isDocumentInCodeIntelligenceScope(external, 'engine/main.cpp')).toBe(false)
    expect(isCodeIntelligenceResultVisible(external, 'engine/main.cpp')).toBe(false)
  })

  it('resolves win32 absolute members case-insensitively against the root', () => {
    const mixed = scope([{ path: 'D:\\SDK\\external', visibleResults: true }], 'D:\\workspace')
    expect(isDocumentInCodeIntelligenceScope(mixed, 'engine/main.cpp')).toBe(false)
    const nested = scope([{ path: 'd:/WORKSPACE/engine', visibleResults: true }], 'D:\\workspace')
    expect(isDocumentInCodeIntelligenceScope(nested, 'engine/main.cpp')).toBe(true)
  })

  it('keeps longest-match visibility across member forms', () => {
    const mixed = scope([
      { path: '/workspace/engine', visibleResults: false },
      { path: 'engine/core', visibleResults: true }
    ])
    expect(isCodeIntelligenceResultVisible(mixed, 'engine/core/main.cpp')).toBe(true)
    expect(isCodeIntelligenceResultVisible(mixed, 'engine/util.cpp')).toBe(false)
  })
})

describe('getCodeIntelligenceMembershipAction (three-state tree rule)', () => {
  it('reports remove for an exact member and disabled for a strict subpath', () => {
    const members = scope([{ path: 'engine', visibleResults: true }])
    expect(getCodeIntelligenceMembershipAction(members, 'engine')).toBe('remove')
    expect(getCodeIntelligenceMembershipAction(members, 'engine/core')).toBe('disabled')
  })

  it('reports add outside every member and for a parent of a member', () => {
    const members = scope([{ path: 'engine/core', visibleResults: true }])
    expect(getCodeIntelligenceMembershipAction(members, 'fx')).toBe('add')
    expect(getCodeIntelligenceMembershipAction(members, 'engine')).toBe('add')
  })

  it('treats the workspace-root member as covering every relative path', () => {
    const members = scope([{ path: '.', visibleResults: true }])
    expect(getCodeIntelligenceMembershipAction(members, '.')).toBe('remove')
    expect(getCodeIntelligenceMembershipAction(members, 'engine')).toBe('disabled')
  })

  it('counts absolute members inside the workspace root through their relative form', () => {
    const members = scope([{ path: '/workspace/engine', visibleResults: true }])
    expect(getCodeIntelligenceMembershipAction(members, 'engine/core')).toBe('disabled')
    expect(getCodeIntelligenceMembershipAction(members, 'fx')).toBe('add')
  })
})
