import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG, isTuiAgent } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import type { TuiAgent } from './types'

describe('codeagent', () => {
  it('is a registered TuiAgent with config parity to claude', () => {
    expect(isTuiAgent('codeagent')).toBe(true)
    const codeagent = TUI_AGENT_CONFIG.codeagent
    const claude = TUI_AGENT_CONFIG.claude
    // Why: codeagent is a claude fork; launch/detect/prompt-injection must match.
    expect(codeagent.detectCmd).toBe('codeagent')
    expect(codeagent.launchCmd).toBe('codeagent')
    expect(codeagent.expectedProcess).toBe('codeagent')
    expect(codeagent.promptInjectionMode).toBe(claude.promptInjectionMode)
    expect(codeagent.draftPromptFlag).toBe(claude.draftPromptFlag)
  })

  it('keeps TUI_AGENT_CONFIG and TUI_AGENT_DISPLAY_NAMES keys in sync', () => {
    const configKeys = Object.keys(TUI_AGENT_CONFIG).sort() as TuiAgent[]
    const displayKeys = Object.keys(TUI_AGENT_DISPLAY_NAMES).sort() as TuiAgent[]
    expect(displayKeys).toEqual(configKeys)
    expect(TUI_AGENT_DISPLAY_NAMES.codeagent).toBe('Codeagent')
  })
})
