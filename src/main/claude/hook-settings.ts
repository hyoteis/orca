import { homedir } from 'node:os'
import { basename, extname, join, win32 } from 'node:path'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  type HookCommandConfig,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { wrapRuntimeHomeHookCommand } from '../agent-hooks/runtime-home-hook-command'

export type ClaudeCompatibleHookSettings = {
  configDirName: '.claude' | '.openclaude' | '.cac'
  scriptBaseName: 'claude-hook' | 'openclaude-hook' | 'codeagent-hook'
  supportsExecHookArgs: boolean
  /** Why: the codeagent fork wraps every hook as `bash -c "bash <command> <args>"`,
   *  so any shell syntax (if/case/${...}) in command is a syntax error and a
   *  .cmd is unrunnable batch — command must be a bare .sh path. */
  hookCommandStyle?: 'shell-one-liner' | 'script-path'
}

export const CLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.claude',
  scriptBaseName: 'claude-hook',
  supportsExecHookArgs: true
}

export const OPENCLAUDE_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.openclaude',
  scriptBaseName: 'openclaude-hook',
  supportsExecHookArgs: false
}

// Why: codeagent reads ~/.cac/settings.json, but its hook executor joins
// command+args behind a `bash -c "bash …"` wrap — the exec form dies on
// stripped backslashes and any shell one-liner is a syntax error under the
// doubled bash, so it gets a bare .sh script path instead.
export const CODEAGENT_HOOK_SETTINGS: ClaudeCompatibleHookSettings = {
  configDirName: '.cac',
  scriptBaseName: 'codeagent-hook',
  supportsExecHookArgs: false,
  hookCommandStyle: 'script-path'
}

export const CLAUDE_EVENTS = [
  // Why: SessionStart is the only event a resumed/idle session emits before the
  // first prompt; without it the sidebar row can't exist until the user types (STA-3386).
  { eventName: 'SessionStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: OpenClaude skips normal Stop hooks after API/model errors and emits
  // StopFailure instead; without this hook Orca leaves the turn spinning.
  { eventName: 'StopFailure', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: subagent/teammate lifecycle feeds the sidebar's child rows and keeps
  // a pane 'working' while background children outlive the lead's turn.
  // TeammateIdle parks turn-based teammates without trusting their permanently
  // "running" background_tasks entry to gate the pane.
  // Older Claude builds ignore unregistered event names (StopFailure precedent).
  { eventName: 'SubagentStart', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'SubagentStop', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'TeammateIdle', definition: { hooks: [{ type: 'command', command: '' }] } },
  // Why: PreToolUse gives the dashboard a live readout of the in-flight tool
  // (name + input preview) before it completes.
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  }
] as const

export function getConfigPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return join(homedir(), settings.configDirName, 'settings.json')
}

export function getStatusLineScriptBaseName(settings = CLAUDE_HOOK_SETTINGS): string {
  return settings.scriptBaseName.replace(/-hook$/, '-statusline')
}

export function getStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return process.platform === 'win32'
    ? `${getStatusLineScriptBaseName(settings)}.cmd`
    : getPosixStatusLineScriptFileName(settings)
}

export function getPosixStatusLineScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${getStatusLineScriptBaseName(settings)}.sh`
}

export function getStatusLineScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getStatusLineScriptFileName(settings))
}

export function getManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  // Why: a script-path command is executed by bash itself (the fork's `bash -c
  // "bash <command>"` wrap), which cannot run .cmd batch content.
  if (process.platform === 'win32' && settings.hookCommandStyle !== 'script-path') {
    return `${settings.scriptBaseName}.cmd`
  }
  return getPosixManagedScriptFileName(settings)
}

export function getPosixManagedScriptFileName(settings = CLAUDE_HOOK_SETTINGS): string {
  return `${settings.scriptBaseName}.sh`
}

export function getManagedScriptPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(getManagedScriptFileName(settings))
}

export function getRemoteConfigPath(remoteHome: string, settings = CLAUDE_HOOK_SETTINGS): string {
  return `${remoteHome.replace(/\/$/, '')}/${settings.configDirName}/settings.json`
}

export function getManagedCommand(scriptPath: string, settings = CLAUDE_HOOK_SETTINGS): string {
  const scriptFileName = basename(scriptPath)
  const extension = extname(scriptFileName)
  const baseName = extension ? scriptFileName.slice(0, -extension.length) : scriptFileName
  if (settings.hookCommandStyle === 'script-path') {
    // Why: no shell syntax survives the fork's `bash -c "bash <command>"` wrap —
    // a bare quoted $HOME path runs under both that wrap and a plain `bash -c`.
    return `"$HOME/.orca/agent-hooks/${scriptFileName}"`
  }
  return wrapRuntimeHomeHookCommand(baseName)
}

export function getManagedLifecycleHook(
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS
): HookCommandConfig {
  if (process.platform !== 'win32' || !settings.supportsExecHookArgs) {
    return buildManagedCommandHook(getManagedCommand(scriptPath, settings))
  }
  return getWindowsManagedLifecycleHook(scriptPath)
}

export function getWindowsManagedLifecycleHook(scriptPath: string): HookCommandConfig {
  const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const runtimeScriptPath = win32.join(
    '%USERPROFILE%',
    '.orca',
    'agent-hooks',
    win32.basename(scriptPath)
  )
  // Why: Claude's Windows shell form opens Git Bash consoles; exec form hosts the client in a windowless console.
  return {
    type: 'command',
    command: win32.join(system32, 'conhost.exe'),
    args: ['--headless', win32.join(system32, 'cmd.exe'), '/d', '/c', runtimeScriptPath],
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

export function hasSameManagedHookInvocation(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): boolean {
  return (
    actual.command === expected.command &&
    JSON.stringify(actual.args ?? []) === JSON.stringify(expected.args ?? [])
  )
}

export function getRemoteManagedCommand(
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS
): string {
  return getManagedCommand(scriptPath, settings)
}

export function applyManagedHooks(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName = getManagedScriptFileName()
): HooksConfig {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)

  for (const event of CLAUDE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      ...event.definition,
      hooks: [hook]
    }
    nextHooks[event.eventName] = [...cleaned, definition]
  }

  return { ...config, hooks: nextHooks }
}

export type StatusLineSlotState = 'managed' | 'user' | 'empty'

// Why: install policy needs "user owns the slot" vs "slot is empty" vs "ours" — an empty slot
// after a prior install means the user deleted the managed entry, which install must respect.
export function getStatusLineSlotState(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): StatusLineSlotState {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand) {
    return 'empty'
  }
  return isManagedCommand(currentCommand) ? 'managed' : 'user'
}

// Why: records that the managed statusline was installed once, so a later empty slot reads as user opt-out.
export function getStatusLineInstallMarkerPath(settings = CLAUDE_HOOK_SETTINGS): string {
  return getSharedManagedScriptPath(`${getStatusLineScriptBaseName(settings)}.installed`)
}

// Why: statusLine is a single settings slot, not a hooks array — never overwrite a
// user-owned status line; the usage feed then simply falls back to the OAuth poll.
export function applyManagedStatusLine(
  config: HooksConfig,
  command: string,
  scriptFileName = getStatusLineScriptFileName()
): HooksConfig {
  if (getStatusLineSlotState(config, scriptFileName) === 'user') {
    return config
  }
  return { ...config, statusLine: { type: 'command', command } }
}

export function removeManagedStatusLine(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): { config: HooksConfig; changed: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const current = config.statusLine
  const currentCommand =
    isPlainObject(current) && typeof current.command === 'string' ? current.command : null
  if (!currentCommand || !isManagedCommand(currentCommand)) {
    return { config, changed: false }
  }
  const next = { ...config }
  delete next.statusLine
  return { config: next, changed: true }
}

export function removeManagedHooks(
  config: HooksConfig,
  scriptFileName = getManagedScriptFileName()
): {
  config: HooksConfig
  changed: boolean
} {
  const nextHooks = { ...config.hooks }
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) {
      changed = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return {
    config: { ...config, hooks: nextHooks },
    changed
  }
}
