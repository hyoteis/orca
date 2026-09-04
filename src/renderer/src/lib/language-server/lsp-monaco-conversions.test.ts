// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import {
  lspToMonacoCompletionItem,
  lspToMonacoSignatureHelp,
  monacoMarkerToLspDiagnostic
} from './lsp-monaco-conversions'

const wordRange: Monaco.IRange = {
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 9
}

describe('lspToMonacoCompletionItem', () => {
  it('maps kinds, snippets, text edits, and additional edits', () => {
    const item = lspToMonacoCompletionItem({
      item: {
        label: 'sqrt',
        kind: 3, // Function
        detail: 'math.sqrt',
        insertTextFormat: 2,
        insertText: 'sqrt(${1:x})',
        textEdit: {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
          newText: 'sqrt(${1:x})'
        },
        additionalTextEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'import math\n'
          }
        ]
      },
      wordRange
    })
    expect(item.kind).toBe(1) // monaco Function
    expect(item.insertTextRules).toBe(4) // InsertAsSnippet
    expect(item.insertText).toBe('sqrt(${1:x})')
    expect(item.range).toEqual({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 })
    expect(item.additionalTextEdits).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'import math\n' }
    ])
  })

  it('drops the server command so completion commands never auto-run (#20)', () => {
    const item = lspToMonacoCompletionItem({
      item: { label: 'x', kind: 6, command: { title: 't', command: 'editor.action.trigger' } },
      wordRange
    })
    expect(item.command).toBeUndefined()
  })

  it('falls back to the label and word range without insertText', () => {
    const item = lspToMonacoCompletionItem({ item: { label: 'os' }, wordRange })
    expect(item.insertText).toBe('os')
    expect(item.range).toBe(wordRange)
  })
})

describe('lspToMonacoSignatureHelp', () => {
  it('maps signatures, parameters, and active indices', () => {
    const help = lspToMonacoSignatureHelp({
      signatures: [
        {
          label: 'sqrt(x: float) -> float',
          parameters: [
            { label: [5, 14], documentation: { kind: 'markdown', value: 'the value' } }
          ]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    })
    expect(help.activeSignature).toBe(0)
    expect(help.signatures[0].parameters[0].label).toEqual([5, 14])
    expect(help.signatures[0].parameters[0].documentation).toEqual({ value: 'the value' })
  })

  it('defaults missing active indices', () => {
    const help = lspToMonacoSignatureHelp({ signatures: [{ label: 'f()', parameters: [] }] })
    expect(help.activeSignature).toBe(0)
    expect(help.activeParameter).toBe(0)
  })
})

describe('monacoMarkerToLspDiagnostic', () => {
  it('shifts ranges and reverses severity', () => {
    const diagnostic = monacoMarkerToLspDiagnostic({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 8,
      message: 'oops',
      severity: 8,
      source: 'orca-python'
    })
    expect(diagnostic).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 7 }
      },
      message: 'oops',
      severity: 1,
      source: 'orca-python'
    })
  })
})
