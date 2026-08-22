import { describe, expect, it } from 'vitest'
import { toClientDocumentUri, toServerFileUri } from './language-server-document-uri'
describe('language-server document mapping', () => {
  it('isolates identical paths by Host and scope', () => {
    const path = 'src/main.cpp'
    expect(
      toClientDocumentUri({ executionHostId: 'ssh:a', scopeId: 'engine', kind: 'clangd' }, path)
    ).not.toBe(
      toClientDocumentUri({ executionHostId: 'ssh:b', scopeId: 'engine', kind: 'clangd' }, path)
    )
  })
  it('maps Windows host paths to file URIs', () => {
    expect(toServerFileUri('C:\\repo\\a b.cpp')).toBe('file:///C%3A/repo/a%20b.cpp')
  })
})
