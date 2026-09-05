// Per-pane wiring (#91/#96) of the pure colorizer into the live and replay
// write paths. One instance per pane binding so held line/escape state is
// shared across live output, replay payloads, and their live continuation.

import {
  createTerminalLogLevelColorizer,
  type TerminalLogLevelColorizer
} from './terminal-log-level-colorizer'

type TerminalLogLevelColorizerWiring = {
  /** Live PTY output. `alternateScreenActive` comes from the kitty keyboard
   *  mode mirror (xterm's buffer.type lags the write and cannot be used);
   *  full-screen TUI bytes pass through untouched, state frozen not reset. */
  transformLive(data: string, alternateScreenActive: boolean): string
  /** Serialized replay payloads; same instance/state as the live path.
   *  Why no mirror gate here: serialized bytes are escape-dense (SGR/cursor
   *  per line), so TUI frames self-defend into passthrough while the plain
   *  scrollback an alt-screen snapshot pairs with still gets colored. */
  transformReplay(data: string): string
  /** Drop cross-chunk state before an authoritative replay rewrite — a held
   *  escape tail would otherwise swallow the replay's leading bytes. */
  resetForReplay(): void
}

export function createTerminalLogLevelColorizerWiring(
  isEnabled: () => boolean
): TerminalLogLevelColorizerWiring {
  const colorizer: TerminalLogLevelColorizer = createTerminalLogLevelColorizer()
  let enabled = false
  // A falling edge mid-line must drop held state: the passthrough bytes it
  // held against never reached xterm, so completing them later miscolors.
  const syncEnabled = (): boolean => {
    const next = isEnabled()
    if (enabled && !next) {
      colorizer.reset()
    }
    enabled = next
    return next
  }
  return {
    transformLive: (data, alternateScreenActive) =>
      syncEnabled() && !alternateScreenActive ? colorizer.transform(data) : data,
    transformReplay: (data) => (syncEnabled() ? colorizer.transform(data) : data),
    resetForReplay: () => colorizer.reset()
  }
}
