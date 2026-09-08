import { SymbolKind } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'
import { outlineLanguageFamily, type OutlineSymbolRow } from './outline-model'

// ponytail: per-line regexes, no comment/string state machine — triple-quoted
// Python strings and C++ block comments can still yield phantom symbols; the
// approximate badge is the contract that covers this ceiling.

type LineMatch = { name: string; kind: number; column: number }


const CPP_DECL_PREFIX =
  /^\s*(?:static|inline|virtual|explicit|constexpr|friend|extern|thread_local)\s+/
const CPP_BAD_PREFIX_WORDS = new Set([
  'return',
  'else',
  'case',
  'delete',
  'throw',
  'new',
  'co_return',
  'co_await',
  'goto',
  'using',
  'typedef',
  'sizeof'
])

function cppTailAfterLastParen(line: string): string {
  const close = line.lastIndexOf(')')
  return close === -1 ? '' : line.slice(close + 1)
}

/** `) {` / `);` / `) const` / `) : Base(...)` … — a definition tail, not a call. */
function cppDefinitionTail(tail: string): boolean {
  return /^\s*(?:const|noexcept|override|final|->[^;({]*)*\s*(?:[;{,]|:\s[^;]*|$)/.test(tail)
}

function cppLine(line: string): LineMatch | null {
  const text = line.replace(CPP_DECL_PREFIX, '')
  if (!text.trim() || text.trim().startsWith('//') || text.trim().startsWith('*')) {
    return null
  }
  const columnShift = line.length - text.length
  let match = /^\s*(?:inline\s+)?namespace\s+([A-Za-z_]\w*)/.exec(text)
  if (match) {
    return {
      name: match[1],
      kind: SymbolKind.Namespace,
      column: columnShift + match.index + match[0].indexOf(match[1])
    }
  }
  match = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(text)
  if (match) {
    return {
      name: match[1],
      kind: SymbolKind.Constant,
      column: columnShift + match[0].indexOf(match[1])
    }
  }
  match = /^\s*enum(?:\s+class)?\s+([A-Za-z_]\w*)/.exec(text)
  if (match) {
    return {
      name: match[1],
      kind: SymbolKind.Enum,
      column: columnShift + match[0].indexOf(match[1])
    }
  }
  // Forward declarations have no body on the line; real definitions carry `{`.
  match = /^\s*(class|struct)\s+([A-Za-z_]\w*)/.exec(text)
  if (match) {
    if (!text.includes('{') && text.trimEnd().endsWith(';')) {
      return null
    }
    return {
      name: match[2],
      kind: match[1] === 'class' ? SymbolKind.Class : SymbolKind.Struct,
      column: columnShift + match.index + match[0].indexOf(match[2])
    }
  }
  // Qualified out-of-line definitions need no return type (`TextureVk::TextureVk(`).
  match = /^\s*([A-Za-z_]\w*::[A-Za-z_]\w*)\s*\(/.exec(text)
  if (match) {
    const tail = cppTailAfterLastParen(text)
    if (cppDefinitionTail(tail) && tail.trim() !== ';') {
      // Qualifier == name marks an out-of-line constructor definition.
      const [qualifier, name] = match[1].split('::')
      return {
        name: match[1],
        kind: qualifier === name ? SymbolKind.Constructor : SymbolKind.Function,
        column: columnShift + match.index + match[0].indexOf(match[1])
      }
    }
  }
  // Capitalized name directly at indent followed by a ctor-style tail.
  match = /^\s*([A-Z][A-Za-z_]\w*)\s*\(/.exec(text)
  if (match && /^\s*[:{]/.test(cppTailAfterLastParen(text))) {
    return {
      name: match[1],
      kind: SymbolKind.Constructor,
      column: columnShift + match.index + match[0].indexOf(match[1])
    }
  }
  // Typed definitions: at least one type token before the name.
  match =
    /^\s*(?:[A-Za-z_][\w:]*(?:<[^>()]*>)?[\s*&]+)+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/.exec(text)
  if (match) {
    const prefixWord = /^\s*(\S+)/.exec(text)?.[1] ?? ''
    if (!CPP_BAD_PREFIX_WORDS.has(prefixWord) && cppDefinitionTail(cppTailAfterLastParen(text))) {
      return {
        name: match[1],
        kind: SymbolKind.Function,
        column: columnShift + match.index + match[0].lastIndexOf(match[1])
      }
    }
  }
  match = /^\s*[A-Za-z_][\w:<>*&]*\s+([A-Za-z_]\w*)\s*(?:=|\[|;)/.exec(text)
  if (match && !CPP_BAD_PREFIX_WORDS.has(text.trim().split(/\s+/)[0] ?? '')) {
    return {
      name: match[1],
      kind: SymbolKind.Variable,
      column: columnShift + match.index + match[0].indexOf(match[1])
    }
  }
  return null
}

/** Heuristic tier 3 (ADR 0003): flat, line-level, approximate rows. */
export function extractHeuristicOutlineRows(text: string, language: string): OutlineSymbolRow[] {
  const family: CodeIntelligenceLanguage | null = outlineLanguageFamily(language)
  if (!family) {
    return []
  }
  const lines = text.split('\n')
  const matches: (LineMatch & { line: number })[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = cppLine(lines[index])
    if (match) {
      matches.push({ ...match, line: index })
    }
  }
  const lastLine = lines.length - 1
  return matches.map((match, index) => {
    const spanEnd = index + 1 < matches.length ? matches[index + 1].line - 1 : lastLine
    return {
      key: `${match.name}@${match.line + 1}`,
      name: match.name,
      kind: match.kind,
      line: match.line + 1,
      range: {
        start: { line: match.line, character: match.column },
        end: { line: match.line, character: match.column + match.name.length }
      },
      span: {
        start: { line: match.line, character: 0 },
        end: { line: Math.max(spanEnd, match.line), character: 0 }
      },
      children: []
    }
  })
}
