import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// C1 gate: channel names are hand-mirrored between preload invoke and main
// handle; one-sided drift (typo/rename) fails silently at runtime. Types are
// already locked by `satisfies PreloadApi` — strings are the only open seam.

// tsconfig.node builds this glob as CommonJS, so import.meta is unavailable.
const srcRoot = join(__dirname, '..')

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(srcRoot, dir))) {
    const full = join(srcRoot, dir, entry)
    if (statSync(full).isDirectory()) {
      listSourceFiles(join(dir, entry), acc)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

function preloadInvokeChannels(): Set<string> {
  const channels = new Set<string>()
  // `ipc` covers modules that receive ipcRenderer as a constructor param
  // (language-server-sessions, runtime-environment-subscriptions, usage-provider-api).
  const invokePattern = /(?:ipcRenderer|ipc)\.invoke\(\s*['"]([^'"]+)['"]/g
  for (const file of listSourceFiles('preload')) {
    for (const match of readFileSync(file, 'utf8').matchAll(invokePattern)) {
      channels.add(match[1])
    }
  }
  return channels
}

function mainHandleChannels(): Set<string> {
  const channels = new Set<string>()
  for (const file of listSourceFiles('main')) {
    const source = readFileSync(file, 'utf8')
    // `const C = 'x'` indirection (attach-main-window-services, runtime-environment-recovery-handler).
    const constants = new Map<string, string>()
    for (const match of source.matchAll(/const\s+(\w+)\s*=\s*['"]([a-zA-Z][\w:-]+)['"]/g)) {
      constants.set(match[1], match[2])
    }
    for (const match of source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) {
      channels.add(match[1])
    }
    for (const match of source.matchAll(/ipcMain\.handle\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
      const resolved = constants.get(match[1])
      if (resolved) {
        channels.add(resolved)
      }
    }
  }
  return channels
}

describe('ipc invoke channel parity', () => {
  it('keeps preload invoke and main handle channel sets identical', () => {
    const preload = preloadInvokeChannels()
    const main = mainHandleChannels()
    expect(preload.size).toBeGreaterThan(600)
    expect([...preload].filter((channel) => !main.has(channel))).toEqual([])
    expect([...main].filter((channel) => !preload.has(channel))).toEqual([])
  })
})
