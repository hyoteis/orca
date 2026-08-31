import { describe, expect, it } from 'vitest'
import {
  discoverCodeIntelligenceDirectories,
  filterCodeIntelligenceDirectories,
  getCodeIntelligenceCustomPaths,
  getMinimalCodeIntelligenceDirectories,
  sortCodeIntelligenceDirectories
} from './code-intelligence-directory-list'

describe('code intelligence directory list', () => {
  it('groups paths by their top-level directory and puts shallower paths first', () => {
    expect(
      sortCodeIntelligenceDirectories([
        'Zeta/render/backend',
        'Alpha/tools',
        'Zeta',
        '.',
        'Alpha/render/backend',
        'Alpha'
      ])
    ).toEqual(['.', 'Alpha', 'Alpha/tools', 'Alpha/render/backend', 'Zeta', 'Zeta/render/backend'])
  })

  it('filters case-insensitively and accepts Windows separators', () => {
    expect(
      filterCodeIntelligenceDirectories(
        ['DiligentCore/Graphics', 'DiligentFX/Components', 'DiligentTools'],
        'core\\graph'
      )
    ).toEqual(['DiligentCore/Graphics'])
  })

  it('derives every real parent directory from the project file list', () => {
    expect(
      discoverCodeIntelligenceDirectories([
        'lume/LumeBase/api/base/containers/array_view.h',
        'lume/LumeBase/src/engine.cpp',
        'kits\\ets\\BUILD.gn',
        '.git/config'
      ])
    ).toEqual([
      '.',
      'kits',
      'kits/ets',
      'lume',
      'lume/LumeBase',
      'lume/LumeBase/api',
      'lume/LumeBase/src',
      'lume/LumeBase/api/base',
      'lume/LumeBase/api/base/containers'
    ])
  })

  it('compresses fully covered subtrees to their topmost selected directory', () => {
    const directories = ['.', 'lume', 'lume/LumeBase', 'lume/LumeBase/api', 'lume/LumeRender']
    const selected = new Set(['lume/LumeBase', 'lume/LumeBase/api'])

    expect(getMinimalCodeIntelligenceDirectories(directories, selected)).toEqual(['lume/LumeBase'])
  })

  it('keeps custom host-absolute selections separate from detected directories', () => {
    const directories = ['.', 'lume', 'lume/LumeRender']
    const selected = new Set(['lume', '/opt/sdk', 'D:\\other\\project', 'lume/LumeRender'])

    expect(getCodeIntelligenceCustomPaths(directories, selected)).toEqual([
      '/opt/sdk',
      'D:\\other\\project'
    ])
    expect(getMinimalCodeIntelligenceDirectories(directories, selected)).toEqual(['lume'])
  })
})
