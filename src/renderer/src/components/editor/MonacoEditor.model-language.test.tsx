// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
        editorFontZoomLevel: 0,
        setPendingEditorReveal: vi.fn(),
        setEditorCursorLine: vi.fn(),
        addDiffComment: vi.fn(),
        deleteDiffComment: vi.fn(),
        updateDiffComment: vi.fn(),
        scrollToDiffCommentId: null,
        setScrollToDiffCommentId: vi.fn(),
        worktreeDiffComments: {}
      }),
    {
      getState: () => ({ pendingEditorReveal: null, pendingEditorFocusRequest: null })
    }
  )
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('./monaco-e2e-probe', () => ({ installMonacoE2EProbe: vi.fn(() => () => undefined) }))
vi.mock('./monaco-content-sync', () => ({ syncContentOnMount: vi.fn(() => false) }))
vi.mock('./monaco-markdown-doc-completions', () => ({
  ensureMarkdownDocCompletionProvider: vi.fn(),
  clearMarkdownDocCompletionDocuments: vi.fn(),
  setMarkdownDocCompletionDocuments: vi.fn()
}))
vi.mock('./monaco-markdown-doc-link-decorations', () => ({
  createMarkdownDocLinkDecorationController: vi.fn(() => ({ refresh: vi.fn(), dispose: vi.fn() }))
}))
vi.mock('./editor-shortcuts', () => ({
  installEditorAddReviewNoteShortcut: vi.fn(() => () => undefined),
  installEditorSaveShortcut: vi.fn(() => () => undefined),
  installMonacoEditorFindShortcut: vi.fn(() => () => undefined)
}))
vi.mock('@/lib/file-search-selection', () => ({
  registerFileSearchSelectedTextProvider: vi.fn(() => () => undefined)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import MonacoEditor from './MonacoEditor'

function mountEditor(modelLanguageId: string, language: string): void {
  render(
    <MonacoEditor
      fileId="file"
      filePath="/repo/inc/wrapper.hh"
      viewStateKey={`pane:${modelLanguageId}`}
      relativePath="inc/wrapper.hh"
      content="int main() {}"
      language={language}
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
  const model = {
    uri: { toString: () => 'file:///repo/inc/wrapper.hh' },
    getLanguageId: () => modelLanguageId,
    getVersionId: () => 1
  }
  const editorInstance = {
    getModel: () => model,
    getContainerDomNode: () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }),
    addAction: vi.fn(() => ({ dispose: vi.fn() })),
    getPosition: () => null,
    setPosition: vi.fn(),
    getScrollTop: vi.fn(() => 0),
    setScrollTop: vi.fn(),
    onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
    onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
    onMouseDown: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    focus: vi.fn(),
    hasTextFocus: vi.fn(),
    getSelection: vi.fn(() => null),
    getValue: vi.fn(() => '')
  }
  const monaco = {
    editor: {
      setModelLanguage: vi.fn(),
      MouseTargetType: { GUTTER_LINE_NUMBERS: 1 },
      onDidChangeMarkers: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
  const onMount = editorProps.current?.onMount as
    | ((editor: unknown, monaco: unknown) => void)
    | undefined
  act(() => {
    onMount?.(editorInstance, monaco)
  })
  expect(monaco.editor.setModelLanguage).toHaveBeenCalledTimes(
    modelLanguageId === language ? 0 : 1
  )
  if (modelLanguageId !== language) {
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(model, language)
  }
}

afterEach(() => {
  cleanup()
  editorProps.current = null
  vi.clearAllMocks()
})

describe('MonacoEditor model language', () => {
  it('re-languages a retained plaintext model to the detected language on mount', () => {
    mountEditor('plaintext', 'cpp')
  })

  it('leaves a fresh model alone when its language already matches', () => {
    mountEditor('cpp', 'cpp')
  })
})
