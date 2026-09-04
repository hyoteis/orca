// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import {
  installSemanticMonacoProviders,
  SEMANTIC_CODE_ACTION_COMMAND,
  type SemanticMonacoLanding,
  type SemanticMonacoLanguageApi
} from './semantic-monaco-providers'
import {
  registerSemanticMonacoDocument,
  formatDocumentBeforeSave,
  semanticDocumentEditorFor
} from './semantic-monaco-documents'

type ProviderCapture = {
  completion?: Monaco.languages.CompletionItemProvider
  signature?: Monaco.languages.SignatureHelpProvider
  codeAction?: Monaco.languages.CodeActionProvider
  rename?: Monaco.languages.RenameProvider
  formatting?: Monaco.languages.DocumentFormattingEditProvider
  rangeFormatting?: Monaco.languages.DocumentRangeFormattingEditProvider
}
const providers: ProviderCapture = {}
let commandHandler: ((accessor: unknown, payload: unknown) => void) | null = null

const monaco = {
  languages: {
    registerCompletionItemProvider: (_language: string, provider: ProviderCapture['completion']) => {
      providers.completion = provider
    },
    registerSignatureHelpProvider: (_language: string, provider: ProviderCapture['signature']) => {
      providers.signature = provider
    },
    registerCodeActionProvider: (_language: string, provider: ProviderCapture['codeAction']) => {
      providers.codeAction = provider
    },
    registerRenameProvider: (_language: string, provider: ProviderCapture['rename']) => {
      providers.rename = provider
    },
    registerDocumentFormattingEditProvider: (
      _language: string,
      provider: ProviderCapture['formatting']
    ) => {
      providers.formatting = provider
    },
    registerDocumentRangeFormattingEditProvider: (
      _language: string,
      provider: ProviderCapture['rangeFormatting']
    ) => {
      providers.rangeFormatting = provider
    }
  },
  editor: {
    registerCommand: (_id: string, handler: (accessor: unknown, payload: unknown) => void) => {
      commandHandler = handler
      return { dispose: () => {} }
    },
    getModelMarkers: () => []
  }
} as unknown as typeof Monaco

const position = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position
const range = (
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number
): Monaco.Range => ({ startLineNumber, startColumn, endLineNumber, endColumn }) as Monaco.Range

const model = (versionId: number): Monaco.editor.ITextModel =>
  ({
    uri: { toString: () => 'file:///repo/main.py' },
    getVersionId: () => versionId,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 3 }),
    getOptions: () => ({ tabSize: 4, insertSpaces: true })
  }) as unknown as Monaco.editor.ITextModel

const editorFor = (target: Monaco.editor.ITextModel): Monaco.editor.IStandaloneCodeEditor =>
  ({
    getModel: () => target,
    executeEdits: () => true,
    pushUndoStop: () => true
  }) as unknown as Monaco.editor.IStandaloneCodeEditor

const request = {
  fileId: 'file:///repo/main.py',
  filePath: '/repo/main.py',
  relativePath: 'main.py',
  worktreeId: 'demo',
  language: 'python',
  text: 'x = 1',
  documentVersion: 4,
  lineNumber: 1,
  column: 1
}

const api: SemanticMonacoLanguageApi = {
  monacoLanguage: 'python',
  getCompletion: vi.fn(async () => [{ label: 'sqrt', kind: 3 }]),
  getSignatureHelp: vi.fn(async () => ({
    signatures: [{ label: 'f()', parameters: [] }],
    activeSignature: 0,
    activeParameter: 0
  })),
  getFormattingEdits: vi.fn(async () => [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'y' }
  ] as TextEdit[]),
  getRangeFormattingEdits: vi.fn(async () => []),
  getRenameEdit: vi.fn(),
  getCodeActions: vi.fn(async () => [{ title: 'Quick fix', kind: 'quickfix' }]),
  formatOnSaveEnabled: vi.fn(() => false)
} as SemanticMonacoLanguageApi

const landing = {
  applyWorkspaceEdit: vi.fn(async () => 'committed' as const),
  executeCodeAction: vi.fn(async () => undefined),
  syncedVersionFor: vi.fn(() => null)
} as unknown as SemanticMonacoLanding

beforeEach(() => {
  // One-time provider registration persists across tests (idempotent guard);
  // only the per-call mocks reset.
  vi.clearAllMocks()
  installSemanticMonacoProviders(monaco, api, landing)
})

describe('semantic monaco providers', () => {
  it('serves completion items through the shared documents registry', async () => {
    const target = model(4)
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    const result = await providers.completion!.provideCompletionItems(
      target,
      position(1, 2),
      {} as Monaco.languages.CompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    expect(result).toMatchObject({ suggestions: [{ label: 'sqrt', kind: 1 }] })
    unregister()
  })

  it('routes single-document rename edits to monaco and wider edits to the landing', async () => {
    const target = model(4)
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    const singleEdit: WorkspaceEdit = {
      changes: {
        'file:///repo/main.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    }
    vi.mocked(api.getRenameEdit).mockResolvedValueOnce(singleEdit)
    const single = await providers.rename!.provideRenameEdits(
      target,
      position(1, 1),
      'y',
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    expect(single).toMatchObject({ edits: [{ resource: target.uri }] })
    expect(landing.applyWorkspaceEdit).not.toHaveBeenCalled()

    vi.mocked(api.getRenameEdit).mockResolvedValueOnce({
      changes: {
        'file:///repo/other.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }
        ]
      }
    })
    const multi = await providers.rename!.provideRenameEdits(
      target,
      position(1, 1),
      'y',
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    expect(multi).toEqual({ edits: [] })
    expect(landing.applyWorkspaceEdit).toHaveBeenCalledWith(request, expect.anything())
    unregister()
  })

  it('drops formatting results when the document version moved (#20)', async () => {
    const target = model(9) // request was captured at version 4
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    const edits = await providers.formatting!.provideDocumentFormattingEdits(
      target,
      { tabSize: 4, insertSpaces: true },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    expect(edits).toEqual([])
    unregister()
  })

  it('keeps formatting results at the matching version', async () => {
    const target = model(4)
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    const edits = await providers.formatting!.provideDocumentFormattingEdits(
      target,
      { tabSize: 4, insertSpaces: true },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    expect(edits).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'y' }
    ])
    unregister()
  })

  it('executes code actions through the registered landing command', async () => {
    const target = model(4)
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    const actions = await providers.codeAction!.provideCodeActions(
      target,
      range(1, 1, 1, 2),
      { trigger: 1, only: undefined } as unknown as Monaco.languages.CodeActionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
    )
    const action = actions!.actions[0]
    expect(action.command).toMatchObject({ id: SEMANTIC_CODE_ACTION_COMMAND })
    commandHandler!(null, action.command!.arguments)
    expect(landing.executeCodeAction).toHaveBeenCalledWith(request, {
      title: 'Quick fix',
      kind: 'quickfix'
    })
    unregister()
  })

  it('formats on save only when the scope enables it and the version matches', async () => {
    const target = model(4)
    const editor = editorFor(target)
    const unregister = registerSemanticMonacoDocument(editor, () => request)
    vi.mocked(api.formatOnSaveEnabled).mockReturnValueOnce(false)
    expect(await formatDocumentBeforeSave(request, editor)).toBe(false)

    vi.mocked(api.formatOnSaveEnabled).mockReturnValueOnce(true)
    expect(await formatDocumentBeforeSave(request, editor)).toBe(true)

    // Stale request versions drop the formatting entirely (#20).
    const stale = { ...request, documentVersion: 9 }
    vi.mocked(api.formatOnSaveEnabled).mockReturnValueOnce(true)
    expect(await formatDocumentBeforeSave(stale, editor)).toBe(false)
    unregister()
  })

  it('exposes the editor backing a registered document', () => {
    const target = model(4)
    const unregister = registerSemanticMonacoDocument(editorFor(target), () => request)
    expect(semanticDocumentEditorFor(request.fileId)).toMatchObject({ model: target })
    unregister()
    expect(semanticDocumentEditorFor(request.fileId)).toBeNull()
  })
})
