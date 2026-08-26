import { describe, expect, it } from 'vitest'
import { discoverCodeIntelligenceCandidates } from './code-intelligence-scope-discovery'

describe('code intelligence scope discovery', () => {
  it('discovers GN roots alongside CMake roots', () => {
    expect(
      discoverCodeIntelligenceCandidates([
        '.gn',
        'BUILD.gn',
        'engine/BUILD.gn',
        'library/CMakeLists.txt'
      ])
    ).toEqual([
      { relativeRoot: '.', languages: ['cpp'], markers: ['.gn', 'BUILD.gn'] },
      { relativeRoot: 'engine', languages: ['cpp'], markers: ['BUILD.gn'] },
      { relativeRoot: 'library', languages: ['cpp'], markers: ['CMakeLists.txt'] }
    ])
  })
})
