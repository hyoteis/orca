import { describe, expect, it } from 'vitest'
import type { TextEdit } from 'vscode-languageserver-protocol'
import type * as Monaco from 'monaco-editor'
import {
  applyDocumentTextEdits,
  completionTextEditSet,
  documentTextEditOperations
} from './document-semantic-edits'

const edit = (range: { sl: number; sc: number; el: number; ec: number }, text: string): TextEdit =>
  ({
    range: {
      start: { line: range.sl, character: range.sc },
      end: { line: range.el, character: range.ec }
    },
    newText: text
  }) as TextEdit

const model = (version: number): Pick<Monaco.editor.ITextModel, 'getVersionId'> => ({
  getVersionId: () => version
})

type RecordedCall = { source: string; ops: Monaco.editor.IIdentifiedSingleEditOperation[] }

const editor = () => {
  const calls: RecordedCall[] = []
  const undoStops: number[] = []
  const instance = {
    executeEdits: (source: string, ops: Monaco.editor.IIdentifiedSingleEditOperation[]) => {
      calls.push({ source, ops })
      return true
    },
    pushUndoStop: () => {
      undoStops.push(1)
      return true
    }
  }
  return { instance, calls, undoStops }
}

describe('documentTextEditOperations', () => {
  it('converts LSP edits to sorted monaco operations', () => {
    const result = documentTextEditOperations(model(7), [
      edit({ sl: 1, sc: 0, el: 1, ec: 4 }, 'after'),
      edit({ sl: 0, sc: 2, el: 0, ec: 3 }, 'before')
    ], 7)
    expect(result).toEqual({
      ops: [
        {
          range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 4 },
          text: 'before',
          forceMoveMarkers: false
        },
        {
          range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 },
          text: 'after',
          forceMoveMarkers: false
        }
      ]
    })
  })

  it('rejects a stale base version', () => {
    expect(
      documentTextEditOperations(model(8), [edit({ sl: 0, sc: 0, el: 0, ec: 1 }, 'x')], 7)
    ).toEqual({ status: 'stale-version' })
  })

  it('rejects overlapping edits', () => {
    expect(
      documentTextEditOperations(
        model(3),
        [
          edit({ sl: 0, sc: 0, el: 2, ec: 0 }, 'a'),
          edit({ sl: 1, sc: 0, el: 1, ec: 1 }, 'b')
        ],
        3
      )
    ).toEqual({ status: 'overlap' })
  })

  it('rejects empty edit lists', () => {
    expect(documentTextEditOperations(model(3), [], 3)).toEqual({ status: 'empty' })
  })
})

describe('applyDocumentTextEdits', () => {
  it('applies all edits as one undo-grouped executeEdits call', () => {
    const { instance, calls, undoStops } = editor()
    const applied = applyDocumentTextEdits({
      editor: instance,
      model: model(5),
      edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')],
      baseVersion: 5,
      source: 'orca.semanticEdit'
    })
    expect(applied).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].ops).toHaveLength(1)
    expect(calls[0].source).toBe('orca.semanticEdit')
    expect(undoStops).toHaveLength(1)
  })

  it('leaves the model untouched when the base version drifted', () => {
    const { instance, calls, undoStops } = editor()
    const applied = applyDocumentTextEdits({
      editor: instance,
      model: model(6),
      edits: [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'x')],
      baseVersion: 5,
      source: 'orca.semanticEdit'
    })
    expect(applied).toBe(false)
    expect(calls).toHaveLength(0)
    expect(undoStops).toHaveLength(0)
  })
})

describe('completionTextEditSet', () => {
  it('keeps non-overlapping additional edits beside the primary', () => {
    const primary = edit({ sl: 4, sc: 0, el: 4, ec: 5 }, 'inserted')
    const additional = [edit({ sl: 0, sc: 0, el: 0, ec: 0 }, 'import os\n')]
    expect(completionTextEditSet(primary, additional)).toEqual([additional[0], primary])
  })

  it('drops additional edits that overlap the primary (#20)', () => {
    const primary = edit({ sl: 4, sc: 0, el: 6, ec: 0 }, 'inserted')
    const additional = [edit({ sl: 5, sc: 2, el: 5, ec: 4 }, 'x')]
    expect(completionTextEditSet(primary, additional)).toEqual([primary])
  })
})
