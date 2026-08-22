import { describe, expect, it } from 'vitest'
import zh from './locales/zh.json'

describe('code intelligence localization', () => {
  it('ships real Chinese text instead of encoding replacement characters', () => {
    const catalog = zh.settings.codeIntelligence
    expect(catalog.title).toBe('\u4ee3\u7801\u667a\u80fd')
    for (const [key, value] of Object.entries(catalog)) {
      expect(value, `${key} contains replacement text`).not.toMatch(/[?\uFFFD]/)
    }
  })
})
