import { describe, expect, it } from 'vitest'
import zh from './locales/zh.json'

describe('code intelligence localization', () => {
  it('ships real Chinese text instead of encoding replacement characters', () => {
    const catalog = zh.settings.codeIntelligence
    expect(catalog.setupMenu).toBe('\u914d\u7f6e\u4ee3\u7801')
    for (const [key, value] of Object.entries(catalog)) {
      expect(value, `${key} contains replacement text`).not.toMatch(/[?\uFFFD]/)
    }
  })
})
