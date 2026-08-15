import { ClaudeHookService } from '../claude/hook-service'
import { CODEAGENT_HOOK_SETTINGS } from '../claude/hook-settings'

// Why: codeagent is a Claude Code fork; reuse the claude-compatible hook
// lifecycle with its own ~/.cac config dir and codeagent-hook script name.
export const codeagentHookService = new ClaudeHookService({
  agent: 'codeagent',
  displayName: 'Codeagent',
  settings: CODEAGENT_HOOK_SETTINGS
})
