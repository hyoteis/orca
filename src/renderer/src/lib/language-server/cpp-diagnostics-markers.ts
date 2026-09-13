import type * as Monaco from 'monaco-editor'
import type { Diagnostic } from 'vscode-languageserver-protocol'
import type { CppDiagnosticsEvent, CppCodeIntelligenceSession } from './cpp-code-intelligence-session'
import { lspDiagnosticToMonacoMarker } from './lsp-monaco-conversions'

/** Marker owner namespace; every marker we project replaces the prior set. */
export const CPP_DIAGNOSTIC_MARKER_OWNER = 'clangd'

/** Open-model lookup by server-form URI, plus the tracked set for scope wipes. */
export type CppDiagnosticsModelLookup = {
  forServerUri: (uri: string) => Monaco.editor.ITextModel[]
  all: () => Monaco.editor.ITextModel[]
}

/**
 * Projects clangd publishDiagnostics onto Monaco markers (#162). Markers are
 * the single retained diagnostic state: squiggles, hover hints, and the
 * code-action context (`markersToDiagnostics`) all read them back. A scope
 * drop wipes every tracked model so markers never outlive their session.
 *
 * ponytail: overlapping scopes publishing the same URI overwrite each other;
 * merge per-scope marker sets if a workspace ever legitimately maps one file
 * into two C++ scopes.
 */
export function installCppDiagnosticsMarkers(
  monaco: typeof Monaco,
  session: Pick<CppCodeIntelligenceSession, 'onDiagnostics'>,
  models: CppDiagnosticsModelLookup
): () => void {
  const setMarkers = (model: Monaco.editor.ITextModel, diagnostics: readonly Diagnostic[]): void => {
    monaco.editor.setModelMarkers(
      model,
      CPP_DIAGNOSTIC_MARKER_OWNER,
      diagnostics.map(lspDiagnosticToMonacoMarker)
    )
  }
  const onDiagnostics = (event: CppDiagnosticsEvent): void => {
    if (event.type === 'publish') {
      for (const model of models.forServerUri(event.uri)) {
        setMarkers(model, event.diagnostics)
      }
      return
    }
    for (const model of models.all()) {
      setMarkers(model, [])
    }
  }
  return session.onDiagnostics(onDiagnostics)
}
