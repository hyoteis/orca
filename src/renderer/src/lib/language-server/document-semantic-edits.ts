import type { TextEdit } from 'vscode-languageserver-protocol'
import type * as Monaco from 'monaco-editor'

/** Minimal model/editor seams so the pure conversion/apply logic tests in node. */
export type EditModel = Pick<Monaco.editor.ITextModel, 'getVersionId'>
export type EditEditor = Pick<Monaco.editor.IStandaloneCodeEditor, 'executeEdits' | 'pushUndoStop'>
type EditRange = TextEdit['range']

/** Linear position key: lexicographic line/character compare as one number. */
const key = (position: { line: number; character: number }): number =>
  position.line * Number.MAX_SAFE_INTEGER + position.character

const compare = (a: EditRange, b: EditRange): number =>
  key(a.start) - key(b.start) || key(a.end) - key(b.end)

/** Zero-width spans at the same point never overlap; spans do when one
 * strictly contains the other's start inside its open range. */
const overlap = (a: EditRange, b: EditRange): boolean => {
  const first = compare(a, b) <= 0 ? a : b
  const second = first === a ? b : a
  return key(second.start) < key(first.end)
}

export function documentTextEditOperations(
  model: EditModel,
  edits: readonly TextEdit[],
  baseVersion: number
):
  | { ops: Monaco.editor.IIdentifiedSingleEditOperation[] }
  | { status: 'stale-version' | 'overlap' | 'empty' } {
  if (model.getVersionId() !== baseVersion) {
    return { status: 'stale-version' }
  }
  if (edits.length === 0) {
    return { status: 'empty' }
  }
  const sorted = [...edits].sort((a, b) => compare(a.range, b.range))
  for (let index = 1; index < sorted.length; index += 1) {
    if (overlap(sorted[index - 1].range, sorted[index].range)) {
      return { status: 'overlap' }
    }
  }
  return {
    ops: sorted.map((edit): Monaco.editor.IIdentifiedSingleEditOperation => ({
      range: {
        startLineNumber: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLineNumber: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1
      },
      text: edit.newText,
      forceMoveMarkers: false
    }))
  }
}

/**
 * Tier-1 application (#20): current-document completion insertions, explicit
 * formatting, and same-document quick fixes land as ONE Monaco undo group;
 * a drifted base version drops the whole batch instead of corrupting the text.
 */
export function applyDocumentTextEdits(args: {
  editor: EditEditor
  model: EditModel
  edits: readonly TextEdit[]
  baseVersion: number
  source: string
}): boolean {
  const result = documentTextEditOperations(args.model, args.edits, args.baseVersion)
  if (!('ops' in result)) {
    return false
  }
  // One executeEdits call = one undo entry; the leading stop separates it from
  // the user's own typing so a single Ctrl+Z reverts the whole semantic edit.
  args.editor.pushUndoStop()
  return args.editor.executeEdits(args.source, result.ops)
}

/** Completion edits: additionalTextEdits ride along unless they touch the
 * primary insertion span — overlapping additions drop, never merge (#20). */
export function completionTextEditSet(
  primary: TextEdit,
  additional: readonly TextEdit[]
): TextEdit[] {
  return [...additional.filter((candidate) => !overlap(candidate.range, primary.range)), primary]
}
