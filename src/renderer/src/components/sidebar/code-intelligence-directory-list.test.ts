import { describe, expect, it } from 'vitest'
import {
  buildCodeIntelligenceDirectoryTree,
  discoverCodeIntelligenceDirectories,
  filterCodeIntelligenceDirectories,
  expandConfiguredCodeIntelligenceDirectories,
  flattenCodeIntelligenceDirectoryTree,
  getCodeIntelligenceDirectorySelectionState,
  getDefaultCollapsedCodeIntelligenceDirectories,
  getMinimalCodeIntelligenceDirectories,
  sortCodeIntelligenceDirectories,
  toggleCodeIntelligenceDirectorySelection
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

  it('builds ancestor rows for all selectable folders', () => {
    const tree = buildCodeIntelligenceDirectoryTree({
      directories: ['lume/LumeBase', 'lume/LumeRender', 'lume/LumeRender/test/unit', 'kits/ets'],
      query: ''
    })

    expect(tree).toEqual([
      {
        name: 'kits',
        path: 'kits',
        selectable: false,
        children: [{ name: 'ets', path: 'kits/ets', selectable: true, children: [] }]
      },
      {
        name: 'lume',
        path: 'lume',
        selectable: false,
        children: [
          {
            name: 'LumeBase',
            path: 'lume/LumeBase',
            selectable: true,
            children: []
          },
          {
            name: 'LumeRender',
            path: 'lume/LumeRender',
            selectable: true,
            children: [
              {
                name: 'test',
                path: 'lume/LumeRender/test',
                selectable: false,
                children: [
                  {
                    name: 'unit',
                    path: 'lume/LumeRender/test/unit',
                    selectable: true,
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      }
    ])
  })

  it('collapses nested branches but expands all matching search ancestors', () => {
    const tree = buildCodeIntelligenceDirectoryTree({
      directories: ['lume/LumeRender', 'lume/LumeRender/test/unit'],
      query: ''
    })
    const collapsed = getDefaultCollapsedCodeIntelligenceDirectories(tree)

    expect(
      flattenCodeIntelligenceDirectoryTree({ tree, collapsed, expandAll: false }).map(
        (row) => row.path
      )
    ).toEqual(['lume'])
    expect(
      flattenCodeIntelligenceDirectoryTree({ tree, collapsed, expandAll: true }).map(
        (row) => row.path
      )
    ).toEqual(['lume', 'lume/LumeRender', 'lume/LumeRender/test', 'lume/LumeRender/test/unit'])
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

  it('selects a full subtree and reports partial parents as indeterminate', () => {
    const directories = [
      '.',
      'lume',
      'lume/LumeBase',
      'lume/LumeBase/api',
      'lume/LumeBase/src',
      'lume/LumeRender'
    ]
    const fullySelected = toggleCodeIntelligenceDirectorySelection({
      directories,
      selected: new Set(),
      path: 'lume/LumeBase',
      checked: true
    })
    expect([...fullySelected]).toEqual(['lume/LumeBase', 'lume/LumeBase/api', 'lume/LumeBase/src'])
    expect(
      getCodeIntelligenceDirectorySelectionState({
        directories,
        selected: fullySelected,
        path: 'lume/LumeBase'
      })
    ).toBe(true)
    expect(
      getCodeIntelligenceDirectorySelectionState({
        directories,
        selected: fullySelected,
        path: 'lume'
      })
    ).toBe('indeterminate')

    const partial = toggleCodeIntelligenceDirectorySelection({
      directories,
      selected: fullySelected,
      path: 'lume/LumeBase/src',
      checked: false
    })
    expect(
      getCodeIntelligenceDirectorySelectionState({
        directories,
        selected: partial,
        path: 'lume/LumeBase'
      })
    ).toBe('indeterminate')

    const restored = toggleCodeIntelligenceDirectorySelection({
      directories,
      selected: partial,
      path: 'lume/LumeBase/src',
      checked: true
    })
    expect(
      getCodeIntelligenceDirectorySelectionState({
        directories,
        selected: restored,
        path: 'lume/LumeBase'
      })
    ).toBe(true)
  })

  it('expands persisted parent scopes and compresses fully selected trees', () => {
    const directories = ['.', 'lume', 'lume/LumeBase', 'lume/LumeBase/api', 'lume/LumeRender']
    const selected = expandConfiguredCodeIntelligenceDirectories(directories, ['lume/LumeBase'])

    expect([...selected]).toEqual(['lume/LumeBase', 'lume/LumeBase/api'])
    expect(getMinimalCodeIntelligenceDirectories(directories, selected)).toEqual(['lume/LumeBase'])
  })
})
