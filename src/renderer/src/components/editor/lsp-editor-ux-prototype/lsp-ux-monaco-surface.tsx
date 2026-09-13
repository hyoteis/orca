// PROTOTYPE (throwaway) — Monaco surface wired to fake LSP data.
// Wayfinder ticket #179. Branch: prototype/lsp-editor-ux.
import React, { useCallback, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import type * as MonacoNamespace from 'monaco-editor'
import type { editor as MonacoEditorApi, IDisposable, languages } from 'monaco-editor'
import '@/lib/monaco-setup'
import {
  FAKE_COMPLETIONS,
  FAKE_DIAGNOSTICS,
  FAKE_HOVERS,
  SAMPLE_CPP,
  type LspUxServerState
} from './lsp-ux-fake-data'
import type { DiagnosticRow, SeverityKey } from './lsp-ux-status-parts'
import './lsp-editor-ux-prototype.css'

type MonacoApi = typeof MonacoNamespace

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- SAFETY: augmenting the global Window can only merge via interface; a type alias cannot declare-merge.
  interface Window {
    __lspuxPrototypeEditor?: MonacoEditorApi.IStandaloneCodeEditor
    __lspuxPrototypeMonaco?: MonacoApi
  }
}

const MARKER_OWNER = 'lspux-proto'

const SEVERITY_BY_LEVEL: Record<(typeof FAKE_DIAGNOSTICS)[number]['severity'], SeverityKey> = {
  8: 'error',
  4: 'warning',
  2: 'info',
  1: 'hint'
}

/** In syntax-only mode clangd keeps parse errors but drops cross-file checks (warning/info/hint here). */
export function diagnosticsRowsForPhase(phase: LspUxServerState['phase']): DiagnosticRow[] {
  const visible =
    phase === 'syntax-only' ? FAKE_DIAGNOSTICS.filter((d) => d.severity === 8) : FAKE_DIAGNOSTICS
  return visible.map((d) => ({
    severity: SEVERITY_BY_LEVEL[d.severity],
    message: d.message,
    source: d.source,
    line: d.startLine,
    column: d.startColumn
  }))
}

/** kindName → Monaco CompletionItemKind. Monaco's enum is 0-based and re-ordered vs LSP (ticket #173 pitfall). */
function completionKindMap(
  monaco: MonacoApi
): Record<string, languages.CompletionItemKind> {
  const K = monaco.languages.CompletionItemKind
  return {
    Method: K.Method,
    Field: K.Field,
    Function: K.Function,
    Class: K.Class,
    Struct: K.Struct,
    Enum: K.Enum,
    EnumMember: K.EnumMember,
    Variable: K.Variable,
    Constant: K.Constant,
    Keyword: K.Keyword,
    Snippet: K.Snippet,
    Interface: K.Interface
  }
}

function markerSeverityOf(monaco: MonacoApi, level: (typeof FAKE_DIAGNOSTICS)[number]['severity']) {
  if (level === 8) {
    return monaco.MarkerSeverity.Error
  }
  if (level === 4) {
    return monaco.MarkerSeverity.Warning
  }
  if (level === 2) {
    return monaco.MarkerSeverity.Info
  }
  return monaco.MarkerSeverity.Hint
}

/** Markers for the current fake phase; syntax-only drops everything cross-file. */
function fakeMarkers(monaco: MonacoApi, phase: LspUxServerState['phase']) {
  return FAKE_DIAGNOSTICS.filter((d) => phase !== 'syntax-only' || d.severity === 8).map((d) => ({
    startLineNumber: d.startLine,
    endLineNumber: d.startLine,
    startColumn: d.startColumn,
    endColumn: d.endColumn,
    message: `${d.message} (${d.source})`,
    severity: markerSeverityOf(monaco, d.severity),
    source: d.source
  }))
}

export function LspUxMonacoSurface({
  serverState,
  revealLine,
  onRevealDone
}: {
  serverState: LspUxServerState
  revealLine: number | null
  onRevealDone: () => void
}): React.JSX.Element {
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const decorationsRef = useRef<MonacoEditorApi.IEditorDecorationsCollection | null>(null)
  const disposablesRef = useRef<IDisposable[]>([])
  const phaseRef = useRef(serverState.phase)
  phaseRef.current = serverState.phase

  const applyFakeDiagnostics = useCallback((phase: LspUxServerState['phase']) => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()
    if (!monaco || !model) {
      return
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, fakeMarkers(monaco, phase))
    decorationsRef.current?.set(
      FAKE_DIAGNOSTICS.filter((d) => phase !== 'syntax-only' || d.severity === 8).map((d) => ({
        range: new monaco.Range(d.startLine, 1, d.startLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: `lspux-gutter lspux-gutter-${SEVERITY_BY_LEVEL[d.severity]}`,
          glyphMarginHoverMessage: { value: `**${d.source}**: ${d.message}` }
        }
      }))
    )
  }, [])

  const handleMount = (instance: MonacoEditorApi.IStandaloneCodeEditor, monaco: MonacoApi) => {
    editorRef.current = instance
    monacoRef.current = monaco
    const kinds = completionKindMap(monaco)

    decorationsRef.current = instance.createDecorationsCollection([])
    applyFakeDiagnostics(phaseRef.current)
    // Dev-only handle so CDP verification can drive hover/suggest without DOM scraping.
    window.__lspuxPrototypeEditor = instance
    window.__lspuxPrototypeMonaco = monaco

    // Hover: clangd-style markdown (signature + docs + provenance).
    disposablesRef.current.push(
      monaco.languages.registerHoverProvider('cpp', {
        provideHover(model, position) {
          const word = model.getWordAtPosition(position)
          const match = word && FAKE_HOVERS.find((h) => h.word === word.word)
          if (!word || !match) {
            return null
          }
          return {
            range: new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn
            ),
            contents: [{ value: match.markdown }]
          }
        }
      })
    )

    // Completions: kind icons, snippet expansion, docs in the widget's details pane.
    disposablesRef.current.push(
      monaco.languages.registerCompletionItemProvider('cpp', {
        triggerCharacters: ['.', ':'],
        provideCompletionItems(model, position) {
          const before = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          })
          const trigger = before.endsWith('::') ? '::' : before.endsWith('.') ? '.' : null
          if (!trigger) {
            return { suggestions: [] }
          }
          const range = {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          }
          return {
            suggestions: FAKE_COMPLETIONS.filter((c) => c.trigger === trigger).map((c, index) => ({
              label: c.label,
              kind: kinds[c.kindName],
              detail: c.detail,
              documentation: { value: c.documentation },
              insertText: c.insertText,
              insertTextRules:
                c.kindName === 'Snippet'
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              range,
              sortText: String(c.sortBonus ?? 0).padStart(2, '0') + c.label + index
            }))
          }
        }
      })
    )
  }

  useEffect(() => {
    applyFakeDiagnostics(serverState.phase)
  }, [applyFakeDiagnostics, serverState.phase])

  // Diagnostic row click → reveal + focus the line.
  useEffect(() => {
    if (revealLine === null) {
      return
    }
    editorRef.current?.revealLineInCenter(revealLine)
    editorRef.current?.setPosition({ lineNumber: revealLine, column: 1 })
    editorRef.current?.focus()
    onRevealDone()
  }, [revealLine, onRevealDone])

  useEffect(() => {
    const disposables = disposablesRef.current
    return () => {
      for (const disposable of disposables) {
        disposable.dispose()
      }
      disposables.length = 0
    }
  }, [])

  return (
    <div className="lspux-proto min-h-0 flex-1">
      <Editor
        height="100%"
        defaultLanguage="cpp"
        defaultValue={SAMPLE_CPP}
        theme="vs-dark"
        onMount={handleMount}
        options={{
          glyphMargin: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 8 },
          quickSuggestions: { other: true, comments: false, strings: false },
          suggestSelection: 'first'
        }}
        path="lspux-prototype://RefTracker.cpp"
      />
    </div>
  )
}
