import { describe, expect, it } from 'vitest'
import { compilerArguments } from './code-intelligence-compilation-database'

describe('compilerArguments', () => {
  it('builds a C++ command with the shared options', () => {
    expect(compilerArguments('/w/a.cpp', ['/inc'], ['FOO'], 'c++20')).toEqual([
      'clang++',
      '-std=c++20',
      '-DFOO',
      '-I/inc',
      '-c',
      '/w/a.cpp'
    ])
  })

  it('switches to the C compiler and c11 for .c/.m sources', () => {
    expect(compilerArguments('/w/a.c', [], [], 'c++17')).toEqual([
      'clang',
      '-std=c11',
      '-c',
      '/w/a.c'
    ])
  })
})
