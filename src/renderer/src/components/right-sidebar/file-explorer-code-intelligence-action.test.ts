import { describe, expect, it } from 'vitest'
import { getCodeIntelligenceMenuTargetPaths } from './file-explorer-code-intelligence-action'
import type { TreeNode } from './file-explorer-types'

const directory: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}

describe('getCodeIntelligenceMenuTargetPaths', () => {
  it('targets only the right-clicked row outside a multi-selection', () => {
    expect(getCodeIntelligenceMenuTargetPaths(directory, new Set(['/repo/other']))).toEqual([
      '/repo/src'
    ])
  })

  it('targets the whole selection when the row is part of it', () => {
    expect(
      getCodeIntelligenceMenuTargetPaths(
        directory,
        new Set(['/repo/src', '/repo/tools', '/repo/other'])
      )
    ).toEqual(['/repo/src', '/repo/tools', '/repo/other'])
  })
})
