// Pure PTY-output transformer (#91/#94): injects SGR level colors into plain-text
// log lines. No xterm/DOM dependency; wiring into live/replay paths is #96.

// Self-identifiable injected bytes: snapshot serialization re-reads colored
// buffers, so #96 must recognize these exact forms to avoid double injection.
export const LOG_LEVEL_SGR_START = {
  error: '\x1b[91m',
  fatal: '\x1b[1;91m',
  warn: '\x1b[93m',
} as const

export const LOG_LEVEL_SGR_END = '\x1b[0m'

const SELF_INJECTED_SGR = new Set<string>([LOG_LEVEL_SGR_END, ...Object.values(LOG_LEVEL_SGR_START)])

/** True when the escape sequence is one of our own injected SGR forms. */
export function isSelfInjectedSGR(sequence: string): boolean {
  return SELF_INJECTED_SGR.has(sequence)
}

// Line-start-anchored timestamp shapes tolerated before a level token.
const TIMESTAMP_PREFIX =
  '(?:(?:\\d{4}-\\d{2}-\\d{2}[T ])?\\d{1,2}:\\d{2}:\\d{2}(?:[.,]\\d{1,3})?(?:Z|[+-]\\d{2}:?\\d{2})?\\s*|\\[[\\d\\-:T,. Z+]{1,32}]\\s*)?'

type LevelRule = {
  re: RegExp
  sgr: string
}

// Ordered; first hit wins. Generic anchored rows also cover the build tools:
// webpack "ERROR in" / "WARNING in", cargo "error:" / "error[Exxxx]:".
const LEVEL_RULES: LevelRule[] = [
  { re: new RegExp(`^${TIMESTAMP_PREFIX}\\[?(?:FATAL|CRITICAL|CRIT|PANIC)\\]?(?=$|[\\s:])`), sgr: LOG_LEVEL_SGR_START.fatal },
  { re: new RegExp(`^${TIMESTAMP_PREFIX}(?:\\[?(?:ERROR|ERR)\\]?(?=$|[\\s:])|Error:)`), sgr: LOG_LEVEL_SGR_START.error },
  { re: new RegExp(`^${TIMESTAMP_PREFIX}(?:\\[?(?:WARN|WARNING)\\]?(?=$|[\\s:])|[Ww]arning:)`), sgr: LOG_LEVEL_SGR_START.warn },
  { re: new RegExp(`^${TIMESTAMP_PREFIX}error(?::|\\[E\\d+]:)`), sgr: LOG_LEVEL_SGR_START.error },
  // tsc: the prefix is a path, not a timestamp. Bound to 224 so the whole
  // match starts inside the 256-char prescreen window — a longer path would be
  // flushed as unmatchable there anyway (spec: rare, give up).
  { re: /^(.{1,224}?)\(\d+,\d+\): error TS\d+:/, sgr: LOG_LEVEL_SGR_START.error },
  { re: /^(.{1,224}?)\(\d+,\d+\): warning TS\d+:/, sgr: LOG_LEVEL_SGR_START.warn },
  { re: /^\d+:\d+:\d+ \[vite\] .*error/, sgr: LOG_LEVEL_SGR_START.error },
]

// Prescreen window: a level token must be provable within this many chars, so
// longer lines never stay held (prompt/progress passthrough).
const PRESCREEN_WINDOW = 256
// Hold ceilings while state is carried across chunks (mirrors kitty scan-tail cap).
const HOLD_LIMIT = 4096

type LineMode =
  // Accumulating text, no rule has matched yet — flushed at chunk end.
  | 'collect'
  // A level rule matched so far; hold until terminator.
  | 'candidate'
  // Ruled out (or SGR/cursor escape seen): stream through until next line start.
  | 'pass'

export type TerminalLogLevelColorizer = {
  /** Feed one PTY output chunk; returns the same bytes with injected SGR colors. */
  transform(chunk: string): string
  /** Drop all cross-chunk state (used before replay after a screen clear). */
  reset(): void
}

export function createTerminalLogLevelColorizer(): TerminalLogLevelColorizer {
  // Incomplete escape sequence carried from the previous chunk.
  let escapeTail = ''
  let lineMode: LineMode = 'collect'
  // Raw bytes held for the current line (text + escapes interleaved).
  let lineRaw = ''
  // Escape-free text of the current line, for rule matching.
  let lineText = ''

  const startLine = (): void => {
    lineMode = 'collect'
    lineRaw = ''
    lineText = ''
  }

  const matchLevel = (): string => {
    for (const rule of LEVEL_RULES) {
      if (rule.re.test(lineText)) {
        return rule.sgr
      }
    }
    return ''
  }

  /** Append one text piece, applying prescreen/hold-limit short-circuits. */
  const absorb = (piece: string, out: string[]): void => {
    lineRaw += piece
    lineText += piece
    if (lineMode === 'pass') {
      return
    }
    if (lineMode === 'collect' && lineText.length >= PRESCREEN_WINDOW && matchLevel() === '') {
      out.push(lineRaw)
      startLine()
      lineMode = 'pass'
    } else if (lineRaw.length >= HOLD_LIMIT) {
      out.push(lineRaw)
      startLine()
      lineMode = 'pass'
    }
  }

  const consumeText = (text: string, out: string[]): void => {
    let pos = 0
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch !== '\n' && ch !== '\r') {
        i++
        continue
      }
      // CRLF (PTY ONLCR) is a line ending; a bare \r rewrites the line in
      // place and can never be safely colored (progress bars, prompts).
      const crlf = ch === '\r' && text[i + 1] === '\n'
      const terminator = crlf ? '\r\n' : ch
      const piece = text.slice(pos, i)
      if (lineMode === 'pass') {
        out.push(piece)
      } else {
        absorb(piece, out)
      }
      if (lineMode !== 'pass') {
        if (terminator === '\r') {
          out.push(lineRaw)
        } else {
          const sgr = matchLevel()
          out.push(sgr === '' ? lineRaw : `${sgr}${lineRaw}${LOG_LEVEL_SGR_END}`)
        }
      }
      out.push(terminator)
      startLine()
      pos = i = i + terminator.length
    }
    const tail = text.slice(pos)
    if (tail !== '') {
      if (lineMode === 'pass') {
        out.push(tail)
      } else {
        absorb(tail, out)
      }
    }
  }

  const transform = (chunk: string): string => {
    const buf = escapeTail + chunk
    escapeTail = ''
    const out: string[] = []

    let i = 0
    while (i < buf.length) {
      if (buf[i] !== '\x1b') {
        const nextEsc = buf.indexOf('\x1b', i)
        const end = nextEsc === -1 ? buf.length : nextEsc
        consumeText(buf.slice(i, end), out)
        i = end
        continue
      }

      const seqEnd = escapeSequenceEnd(buf, i)
      if (seqEnd === -1) {
        escapeTail = buf.slice(i)
        if (escapeTail.length > HOLD_LIMIT) {
          // Runaway unterminated OSC — emit as-is rather than buffer unboundedly.
          out.push(escapeTail)
          escapeTail = ''
        }
        break
      }
      if (lineMode !== 'pass') {
        // Any escape inside a line (SGR included) makes it uncolorable:
        // already-colored output must pass through, and cursor/OSC control
        // means line-oriented injection would corrupt the screen.
        out.push(lineRaw)
        startLine()
        lineMode = 'pass'
      }
      out.push(buf.slice(i, seqEnd))
      i = seqEnd
    }

    // Never hold a prompt across chunk boundaries waiting for a terminator:
    // only lines whose rules already match stay candidate.
    if (lineMode === 'collect' && lineRaw !== '') {
      if (matchLevel() === '') {
        out.push(lineRaw)
        startLine()
        lineMode = 'pass'
      } else {
        lineMode = 'candidate'
      }
    }
    return out.join('')
  }

  return {
    transform,
    reset: (): void => {
      escapeTail = ''
      startLine()
    },
  }
}

/**
 * End index (exclusive) of the escape sequence starting at `i`, or -1 when the
 * sequence is incomplete at the buffer end (caller must carry it over).
 */
function escapeSequenceEnd(buf: string, i: number): number {
  const c = buf[i + 1]
  if (c === undefined) {
    return -1
  }
  if (c === '[') {
    // CSI: params/intermediates then any final byte.
    let j = i + 2
    while (j < buf.length) {
      const code = buf.charCodeAt(j)
      if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
        j++
      } else {
        break
      }
    }
    if (j >= buf.length) {
      return -1
    }
    // Final byte must be 0x40–0x7e; a stray control char ends the malformed
    // sequence so the byte itself is still handled (e.g. \n stays a terminator).
    const final = buf.charCodeAt(j)
    return final >= 0x40 && final <= 0x7e ? j + 1 : j
  }
  if (c === ']' || c === 'P' || c === 'X' || c === '^' || c === '_') {
    // OSC/DCS/SOS/PM/APC: terminated by BEL or ST.
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === '\x07') {
        return j + 1
      }
      if (buf[j] === '\x1b') {
        return buf[j + 1] === '\\' ? j + 2 : -1
      }
    }
    return -1
  }
  if (c >= ' ' && c <= '/') {
    // nF escape (ESC ( B ...): intermediates then one final byte.
    return buf[i + 2] === undefined ? -1 : i + 3
  }
  // Two-byte escape (ESC 7, ESC M, RIS, ...) — tolerate any follower so a lone
  // stray ESC cannot desync the tokenizer.
  return i + 2
}
