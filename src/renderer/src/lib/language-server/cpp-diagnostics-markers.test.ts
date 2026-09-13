import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { Diagnostic } from 'vscode-languageserver-protocol'
import {
  CPP_DIAGNOSTIC_MARKER_OWNER,
  installCppDiagnosticsMarkers
} from './cpp-diagnostics-markers'

const diagnostic: Diagnostic = {
  range: {
    start: { line: 2, character: 4 },
    end: { line: 2, character: 9 }
  },
  message: 'unknown type: Widget',
  severity: 1,
  source: 'clangd'
}

function fakeMonaco(): { monaco: typeof Monaco; calls: unknown[][] } {
  const calls: unknown[][] = []
  const monaco = {
    editor: {
      setModelMarkers: (model: unknown, owner: string, markers: unknown[]) =>
        calls.push([model, owner, markers])
    }
  }
  return { monaco: monaco as unknown as typeof Monaco, calls }
}

/** Stub session exposing just the subscription the bridge consumes. */
function fakeSession() {
  let diagnosticsListener: ((event: unknown) => void) | undefined
  return {
    onDiagnostics: vi.fn((listener: (event: unknown) => void) => {
      diagnosticsListener = listener
      return () => {
        diagnosticsListener = undefined
      }
    }),
    publish: (event: unknown) => diagnosticsListener?.(event)
  }
}

const modelA = { uri: 'file:///repo/a.cpp' }

describe('cpp diagnostics markers (#162)', () => {
  it('projects published diagnostics onto matching open models', () => {
    const { monaco, calls } = fakeMonaco()
    const session = fakeSession()
    installCppDiagnosticsMarkers(monaco, session, {
      forServerUri: (uri) => (uri === 'file:///repo/a.cpp' ? [modelA as never] : []),
      all: () => [modelA as never]
    })

    session.publish({
      type: 'publish',
      scopeId: 'scope',
      uri: 'file:///repo/a.cpp',
      diagnostics: [diagnostic]
    })

    expect(calls).toHaveLength(1)
    const [model, owner, markers] = calls[0] as [unknown, string, Monaco.editor.IMarkerData[]]
    expect(model).toBe(modelA)
    expect(owner).toBe(CPP_DIAGNOSTIC_MARKER_OWNER)
    expect(markers[0]).toMatchObject({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 10,
      message: 'unknown type: Widget',
      severity: 8,
      source: 'clangd'
    })
  })

  it('round-trips marker data back through monacoMarkerToLspDiagnostic', async () => {
    const { monacoMarkerToLspDiagnostic } = await import('./lsp-monaco-conversions')
    const { monaco, calls } = fakeMonaco()
    const session = fakeSession()
    installCppDiagnosticsMarkers(monaco, session, {
      forServerUri: () => [modelA as never],
      all: () => []
    })

    session.publish({
      type: 'publish',
      scopeId: 'scope',
      uri: 'file:///repo/a.cpp',
      diagnostics: [diagnostic]
    })

    const markers = (calls[0] as unknown[])[2] as Monaco.editor.IMarkerData[]
    const back = monacoMarkerToLspDiagnostic(markers[0])
    expect(back.range).toEqual(diagnostic.range)
    expect(back.message).toBe(diagnostic.message)
    expect(back.severity).toBe(1)
    expect(back.source).toBe('clangd')
  })

  it('clears every tracked model when the scope drops', () => {
    const { monaco, calls } = fakeMonaco()
    const session = fakeSession()
    installCppDiagnosticsMarkers(monaco, session, {
      forServerUri: () => [modelA as never],
      all: () => [modelA as never]
    })

    session.publish({
      type: 'publish',
      scopeId: 'scope',
      uri: 'file:///repo/a.cpp',
      diagnostics: [diagnostic]
    })
    session.publish({ type: 'scopeCleared', scopeId: 'scope' })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([modelA, CPP_DIAGNOSTIC_MARKER_OWNER, []])
  })

  it('ignores diagnostics with no open model instead of throwing', () => {
    const { monaco, calls } = fakeMonaco()
    const session = fakeSession()
    installCppDiagnosticsMarkers(monaco, session, {
      forServerUri: () => [],
      all: () => []
    })

    expect(() =>
      session.publish({
        type: 'publish',
        scopeId: 'scope',
        uri: 'file:///repo/gone.cpp',
        diagnostics: [diagnostic]
      })
    ).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})
