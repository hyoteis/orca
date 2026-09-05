import { describe, expect, it } from 'vitest'
import zh from './locales/zh.json'

describe('code intelligence localization', () => {
  it('ships real Chinese text instead of encoding replacement characters', () => {
    const catalog = zh.settings.codeIntelligence
    expect(catalog.setupTitle).toBe('配置代码')
    const flatten = (node: unknown): string[] =>
      typeof node === 'string'
        ? [node]
        : Object.values((node ?? {}) as Record<string, unknown>).flatMap(flatten)
    for (const text of flatten(catalog)) {
      expect(text, 'contains replacement text').not.toMatch(/[?�]/)
    }
  })
})
