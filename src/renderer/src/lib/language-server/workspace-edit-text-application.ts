import type { TextEdit } from 'vscode-languageserver-protocol'

/** Applies LSP TextEdits (UTF-16 positions) to text; null when edits overlap
 * or point outside the text (#20 no-guess application). */
export function applyWorkspaceTextEdits(text: string, edits: readonly TextEdit[]): string | null {
  const lineStarts: number[] = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      lineStarts.push(index + 1)
    }
  }
  const offsetOf = (position: { line: number; character: number }): number | null => {
    if (position.line < 0 || position.line >= lineStarts.length) {
      return null
    }
    const start = lineStarts[position.line]
    const lineEnd =
      position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] : text.length + 1
    if (position.character < 0 || start + position.character >= lineEnd) {
      return null
    }
    return start + position.character
  }
  const ordered = [...edits].sort((left, right) => {
    const ls = left.range.start
    const rs = right.range.start
    return ls.line !== rs.line ? rs.line - ls.line : rs.character - ls.character
  })
  let next = text
  // Edits apply back-to-front; an edit reaching past the last applied start overlaps it.
  let appliedStart = Number.MAX_SAFE_INTEGER
  for (const change of ordered) {
    const start = offsetOf(change.range.start)
    const end = offsetOf(change.range.end)
    if (start === null || end === null || end < start || end > appliedStart) {
      return null
    }
    appliedStart = start
    next = next.slice(0, start) + change.newText + next.slice(end)
  }
  return next
}
