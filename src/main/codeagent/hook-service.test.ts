import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { codeagentHookService } from './hook-service'

type TestHook = {
  type: string
  command: string
  args?: readonly string[]
}

// Why: local var, not process.env.HOME — unstubAllEnvs restores the real home
// before cleanup, and rmSync must only ever see the temp dir.
let tmpHome = ''

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codeagent-hook-'))
  vi.stubEnv('HOME', tmpHome)
  vi.stubEnv('USERPROFILE', tmpHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpHome, { recursive: true, force: true })
})

// Why: the codeagent fork runs hooks as `bash -c "bash <command> <args>"`, so
// the exec form dies on stripped backslashes (`C:WINDOWSSystem32conhost.exe`)
// and any shell one-liner (`if … then`) is a syntax error under the doubled
// bash. Only a bare .sh path survives both that wrap and a plain `bash -c`.
describe('codeagentHookService hook form', () => {
  it('writes a bare .sh path command with no shell syntax', () => {
    expect(codeagentHookService.install().state).toBe('installed')

    const settings = JSON.parse(readFileSync(join(tmpHome, '.cac', 'settings.json'), 'utf-8')) as {
      hooks: Record<string, { hooks: TestHook[] }[]>
    }

    const commands = Object.values(settings.hooks).flatMap((entries) =>
      (entries ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook))
    )
    expect(commands.length).toBeGreaterThan(0)
    for (const hook of commands) {
      expect(hook.command).not.toContain('conhost')
      expect(hook.command).not.toMatch(/\b(if|case|then|fi|esac)\b/)
      expect(hook.command).toBe('"$HOME/.orca/agent-hooks/codeagent-hook.sh"')
      // Why: args would be joined into the fork's bash string; keep it empty.
      expect(hook.args).toBeUndefined()
    }
  })

  it('installs a POSIX .sh script even on Windows', () => {
    codeagentHookService.install()

    const shPath = join(tmpHome, '.orca', 'agent-hooks', 'codeagent-hook.sh')
    expect(existsSync(shPath)).toBe(true)
    expect(readFileSync(shPath, 'utf-8')).toContain('#!/bin/sh')
  })
})
