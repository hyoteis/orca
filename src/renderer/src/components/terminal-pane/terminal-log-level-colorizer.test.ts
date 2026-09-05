import { describe, expect, it } from 'vitest'
import {
  LOG_LEVEL_SGR_END,
  LOG_LEVEL_SGR_START,
  createTerminalLogLevelColorizer,
  isSelfInjectedSGR
} from './terminal-log-level-colorizer'

const run = (chunks: string[]): string => {
  const colorizer = createTerminalLogLevelColorizer()
  return chunks.map((chunk) => colorizer.transform(chunk)).join('')
}

describe('terminal log level colorizer core mechanics', () => {
  it('passes plain output through unchanged', () => {
    const data = 'building...\r\ndone in 1.2s\r\n'
    expect(run([data])).toBe(data)
  })

  it('colors a whole ERROR line and preserves the CRLF terminator', () => {
    expect(run(['ERROR: boom\r\n'])).toBe(`\x1b[91mERROR: boom${LOG_LEVEL_SGR_END}\r\n`)
  })

  it('leaves INFO lines uncolored', () => {
    expect(run(['[INFO] server started\r\n', 'INFO: request served\r\n'])).toBe(
      '[INFO] server started\r\nINFO: request served\r\n'
    )
  })

  describe('escape sequences split across chunks', () => {
    it('reassembles a CSI sequence split before its final byte', () => {
      const out = run(['before \x1b[3', '1mred\x1b[0m after\r\n'])
      expect(out).toBe('before \x1b[31mred\x1b[0m after\r\n')
    })

    it('carries a lone ESC at the chunk end', () => {
      const out = run(['text \x1b', '[31mok\x1b[0m\r\n'])
      expect(out).toBe('text \x1b[31mok\x1b[0m\r\n')
    })

    it('reassembles an OSC split before its terminator', () => {
      const out = run(['\x1b]0;win', 'dow\x07tail\r\n'])
      expect(out).toBe('\x1b]0;window\x07tail\r\n')
    })

    it('flushes a runaway unterminated OSC instead of buffering it forever', () => {
      const garbage = 'a'.repeat(5000)
      const out = run(['\x1b]8;;', garbage])
      expect(out).toBe(`\x1b]8;;${garbage}`)
    })

    it('holds a level line whose bytes split after the level token', () => {
      const out = run(['ERROR: fai', 'led to start\r\n'])
      expect(out).toBe(`\x1b[91mERROR: failed to start${LOG_LEVEL_SGR_END}\r\n`)
    })

    it('passes a line through when its first byte is stranded at a chunk tail', () => {
      // The stranded byte is flushed unmatchable by design (never hold a
      // prompt), and the injection point is gone once it is emitted.
      expect(run(['prior line\r\nE', 'RROR: boom\r\n'])).toBe('prior line\r\nERROR: boom\r\n')
    })

    it('does not swallow a newline embedded in a malformed CSI', () => {
      const data = 'ERROR: a\x1b[31\nnext\r\n'
      expect(run([data])).toBe(data)
    })
  })

  describe('prescreen short-circuit', () => {
    it('flushes an unmatchable line once it exceeds the prescreen window', () => {
      const filler = 'x'.repeat(300)
      const out = run([`${filler}ERROR: never anchored\r\n`])
      // Over-256 no-match text streams through; the terminator follows raw.
      expect(out).toBe(`${filler}ERROR: never anchored\r\n`)
    })

    it('does not hold a short prompt across chunk boundaries', () => {
      const colorizer = createTerminalLogLevelColorizer()
      expect(colorizer.transform('user@host:~/proj$ ')).toBe('user@host:~/proj$ ')
      expect(colorizer.transform('ls\r\n')).toBe('ls\r\n')
    })

    it('does not hold a prompt that merely mentions a level word', () => {
      const colorizer = createTerminalLogLevelColorizer()
      expect(colorizer.transform('➜ error-handling git:(main) ✗ ')).toBe('➜ error-handling git:(main) ✗ ')
    })

    it('still colors a level line emitted in small chunks', () => {
      const colorizer = createTerminalLogLevelColorizer()
      colorizer.transform('echo start\r\n')
      expect(colorizer.transform('WARN: low disk\r\n')).toBe(`\x1b[93mWARN: low disk${LOG_LEVEL_SGR_END}\r\n`)
    })
  })

  describe('candidate line terminators', () => {
    it('newline without a rule match passes the line through raw', () => {
      const out = run(['compiling module a\r\n'])
      expect(out).toBe('compiling module a\r\n')
    })

    it('bare \\r (in-place rewrite) never gets colored', () => {
      const out = run(['ERROR: at 50%\r', 'ERROR: at 99%\r', 'done\r\n'])
      expect(out).toBe('ERROR: at 50%\rERROR: at 99%\rdone\r\n')
    })

    it('a cursor-control escape flushes the candidate line uncolored', () => {
      const out = run(['ERROR: partial\x1b[1K', ' overwritten\r\n'])
      expect(out).toBe('ERROR: partial\x1b[1K overwritten\r\n')
    })

    it('an over-4KB candidate line is flushed uncolored at the cap', () => {
      const head = 'ERROR: giant '
      const body = 'y'.repeat(4100)
      const out = run([`${head}${body}\r\n`])
      expect(out).toBe(`${head}${body}\r\n`)
    })
  })

  describe('lines that already contain SGR pass through untouched', () => {
    it('skips injection for program-colored level lines', () => {
      const data = '\x1b[91mERROR: already red\x1b[0m\r\n'
      expect(run([data])).toBe(data)
    })

    it('skips injection for its own previously injected bytes', () => {
      const injected = `\x1b[93mWARNING in ./src/app.js${LOG_LEVEL_SGR_END}\r\n`
      expect(run([injected])).toBe(injected)
    })
  })

  describe('isSelfInjectedSGR', () => {
    it('recognizes exactly the injected forms', () => {
      expect(isSelfInjectedSGR(LOG_LEVEL_SGR_START.error)).toBe(true)
      expect(isSelfInjectedSGR(LOG_LEVEL_SGR_START.fatal)).toBe(true)
      expect(isSelfInjectedSGR(LOG_LEVEL_SGR_START.warn)).toBe(true)
      expect(isSelfInjectedSGR(LOG_LEVEL_SGR_END)).toBe(true)
      expect(isSelfInjectedSGR('\x1b[31m')).toBe(false)
      expect(isSelfInjectedSGR('\x1b[2K')).toBe(false)
    })
  })

  describe('reset', () => {
    it('drops escape-tail and held-line state', () => {
      const colorizer = createTerminalLogLevelColorizer()
      colorizer.transform('held ERROR: tail \x1b[')
      colorizer.reset()
      // Without the reset the tail would reassemble into \x1b[2K, and the
      // rest of the line would land at column 0 as a fresh ERROR line.
      expect(colorizer.transform('2KERROR: fresh\r\n')).toBe('2KERROR: fresh\r\n')
    })
  })
})
