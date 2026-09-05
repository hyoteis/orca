import { describe, expect, it } from 'vitest'
import { LOG_LEVEL_SGR_END, LOG_LEVEL_SGR_START, createTerminalLogLevelColorizer } from './terminal-log-level-colorizer'

const colorize = (line: string): string => {
  const colorizer = createTerminalLogLevelColorizer()
  return colorizer.transform(`${line}\r\n`)
}

/** Strip our injected prefix/suffix: '' means the line stayed uncolored. */
const injectedColor = (line: string): string => {
  const out = colorize(line)
  for (const sgr of Object.values(LOG_LEVEL_SGR_START)) {
    if (out.startsWith(sgr) && out.endsWith(`${LOG_LEVEL_SGR_END}\r\n`)) {
      return sgr
    }
  }
  return ''
}

describe('terminal log level colorizer level patterns', () => {
  describe('generic ERROR', () => {
    it.each([
      'ERROR: connection refused',
      '[ERROR] database unreachable',
      '[ERR] retrying',
      'Error: cannot read file',
      '12:00:00 ERROR: job failed',
      '2026-09-05 12:00:00 ERROR: job failed',
      '[2026-09-05 12:00:00] ERROR: job failed'
    ])('colors %s bright red', (line) => {
      expect(injectedColor(line)).toBe(LOG_LEVEL_SGR_START.error)
    })

    it.each([
      'errors happen in production',
      '0 errors emitted',
      'see ERROR: docs for details',
      'terror: everywhere',
      'SERROR: nope'
    ])('leaves %s uncolored', (line) => {
      expect(injectedColor(line)).toBe('')
    })
  })

  describe('FATAL family', () => {
    it.each(['FATAL: unrecoverable', '[FATAL] crash', 'CRITICAL: disk gone', 'PANIC: nil map'])(
      'colors %s bright red bold',
      (line) => {
        expect(injectedColor(line)).toBe(LOG_LEVEL_SGR_START.fatal)
      }
    )

    it.each(['fatalistically speaking', 'FATALISTIC outlook', 'empathic: none'])(
      'leaves %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })

  describe('WARN family', () => {
    it.each([
      'WARN: disk 90% full',
      'WARNING: deprecated API',
      '[WARN] backpressure',
      '[WARNING] deprecated API',
      'Warning: node version mismatch',
      'warning: cargo says so'
    ])('colors %s bright yellow', (line) => {
      expect(injectedColor(line)).toBe(LOG_LEVEL_SGR_START.warn)
    })

    it.each(['WARNED you already', 'beware: dogs', 'swarm of locusts', 'unwatched: nope'])(
      'leaves %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })

  describe('cargo / rustc', () => {
    it.each([
      'warning: unused variable: `x`',
      'error[E0308]: mismatched types',
      'error: could not compile `app` (bin "app") due to 2 previous errors'
    ])('colors cargo line %s', (line) => {
      // warning → yellow, error → red; both asserted via full output
      const sgr = line.startsWith('warning') ? LOG_LEVEL_SGR_START.warn : LOG_LEVEL_SGR_START.error
      expect(colorize(line)).toBe(`${sgr}${line}${LOG_LEVEL_SGR_END}\r\n`)
    })

    it.each(['error occurred while compiling', '0 errors emitted', 'note: see `rustc --explain E0308`'])(
      'leaves cargo line %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })

  describe('webpack', () => {
    it('colors "ERROR in <module>" bright red', () => {
      expect(injectedColor('ERROR in ./src/app.js')).toBe(LOG_LEVEL_SGR_START.error)
    })

    it('colors "WARNING in <module>" bright yellow', () => {
      expect(injectedColor('WARNING in ./src/lib.js')).toBe(LOG_LEVEL_SGR_START.warn)
    })

    it.each(['error inside the module', 'some ERROR in the middle of a line', 'hint in ./src/x.js'])(
      'leaves %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })

  describe('tsc', () => {
    it('colors a tsc error line bright red', () => {
      expect(injectedColor(`src/app.ts(12,5): error TS2339: Property 'x' does not exist`)).toBe(
        LOG_LEVEL_SGR_START.error
      )
    })

    it('colors a tsc warning line bright yellow', () => {
      expect(injectedColor(`src/app.ts(1,2): warning TS6133: 'x' is declared but never used`)).toBe(
        LOG_LEVEL_SGR_START.warn
      )
    })

    it.each([
      'src/app.ts(12,5): note TS2339: something else',
      'src/app.ts 12,5: error TS2339: no parens'
    ])('leaves %s uncolored', (line) => {
      expect(injectedColor(line)).toBe('')
    })

    it('tolerates a textual prefix before the tsc path (community-regex behavior)', () => {
      expect(injectedColor('see src/app.ts(12,5): error TS2339: x')).toBe(LOG_LEVEL_SGR_START.error)
    })
  })

  describe('vite', () => {
    it.each(['12:34:56 [vite] http proxy error', '12:34:56 [vite] Internal server error: boom'])(
      'colors %s bright red',
      (line) => {
        expect(injectedColor(line)).toBe(LOG_LEVEL_SGR_START.error)
      }
    )

    it.each(['12:34:56 [vite] http server started', '[vite] error without timestamp', '00:00:01 [vitest] nope'])(
      'leaves %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })

  describe('INFO stays uncolored', () => {
    it.each(['INFO: request served', '[INFO] boot complete', '12:00:00 [INFO] heartbeat'])(
      'leaves %s uncolored',
      (line) => {
        expect(injectedColor(line)).toBe('')
      }
    )
  })
})
