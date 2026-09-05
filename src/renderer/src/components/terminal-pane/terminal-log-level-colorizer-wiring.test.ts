import { describe, expect, it } from 'vitest'
import { createTerminalLogLevelColorizerWiring } from './terminal-log-level-colorizer-wiring'
import { LOG_LEVEL_SGR_START } from './terminal-log-level-colorizer'

function createWiring(enabled: () => boolean = () => true) {
  return createTerminalLogLevelColorizerWiring(enabled)
}

describe('createTerminalLogLevelColorizerWiring', () => {
  it('passes through unchanged while the setting is off (default)', () => {
    const wiring = createWiring(() => false)
    expect(wiring.transformLive('[ERROR] boom\r\n', false)).toBe('[ERROR] boom\r\n')
    expect(wiring.transformReplay('[ERROR] boom\r\n')).toBe('[ERROR] boom\r\n')
  })

  it('colors plain-text level lines on the live path when enabled', () => {
    const wiring = createWiring()
    expect(wiring.transformLive('[ERROR] boom\r\n', false)).toBe(
      `${LOG_LEVEL_SGR_START.error}[ERROR] boom\x1b[0m\r\n`
    )
  })

  it('passes live bytes through while the mirror reports alternate screen', () => {
    const wiring = createWiring()
    const tui = '\x1b[?1049h\x1b[1;1Hfull-screen TUI frame'
    expect(wiring.transformLive(tui, true)).toBe(tui)
  })

  it('freezes (not resets) held line state across an alternate-screen window', () => {
    const wiring = createWiring()
    // Candidate line held mid-line; TUI session in between must not lose it.
    expect(wiring.transformLive('[ERROR] part1', false)).toBe('')
    expect(wiring.transformLive('\x1b[?1049hTUI\r\n', true)).toBe('\x1b[?1049hTUI\r\n')
    expect(wiring.transformLive('\x1b[?1049l', true)).toBe('\x1b[?1049l')
    expect(wiring.transformLive(' part2\r\n', false)).toBe(
      `${LOG_LEVEL_SGR_START.error}[ERROR] part1 part2\x1b[0m\r\n`
    )
  })

  it('drops held state when the setting turns off mid-line', () => {
    let enabled = true
    const wiring = createWiring(() => enabled)
    expect(wiring.transformLive('[ERROR] hel', false)).toBe('')
    enabled = false
    expect(wiring.transformLive('lo\r\n', false)).toBe('lo\r\n')
  })

  it('resetForReplay clears a held escape tail before an authoritative rewrite', () => {
    const wiring = createWiring()
    // Live chunk ended mid-escape; without the reset the replay's leading text
    // would be swallowed into a garbage CSI sequence (visible data loss).
    expect(wiring.transformLive('\x1b[91', false)).toBe('')
    wiring.resetForReplay()
    expect(wiring.transformReplay('12:34:56 [ERROR] x\r\n')).toBe(
      `${LOG_LEVEL_SGR_START.error}12:34:56 [ERROR] x\x1b[0m\r\n`
    )
  })

  it('is idempotent on its own injected bytes (snapshot re-read must not grow)', () => {
    const wiring = createWiring()
    const colored = wiring.transformLive('[ERROR] boom\r\n', false)
    expect(wiring.transformReplay(colored)).toBe(colored)
    expect(wiring.transformLive(colored, false)).toBe(colored)
  })

  // Snapshot replay (#96 park/restore, reconnect): SerializeAddon re-encodes
  // the colored buffer. Both serialized shapes below must round-trip unchanged
  // so repeated park/restore cycles never grow the snapshot.
  it('passes serialized scrollback (SGR + CRLF-joined lines) through unchanged', () => {
    const wiring = createWiring()
    const serialized = `${LOG_LEVEL_SGR_START.error}12:34:56 [ERROR] serialized\x1b[0m\r\nplain line\r\n`
    expect(wiring.transformReplay(serialized)).toBe(serialized)
  })

  it('passes serialized alternate-screen TUI frames (cursor escapes) through unchanged', () => {
    const wiring = createWiring()
    const frame = '\x1b[1;1H\x1b[1;91m[ERROR] tui border\x1b[0m\r\x1b[2;1H┌────┐\r\n'
    expect(wiring.transformReplay(frame)).toBe(frame)
  })

  it('keeps cross-chunk state on the replay path (same instance as live)', () => {
    const wiring = createWiring()
    expect(wiring.transformReplay('12:34:56 [WARN] split')).toBe('')
    expect(wiring.transformReplay(' across chunks\r\n')).toBe(
      `${LOG_LEVEL_SGR_START.warn}12:34:56 [WARN] split across chunks\x1b[0m\r\n`
    )
  })
})
