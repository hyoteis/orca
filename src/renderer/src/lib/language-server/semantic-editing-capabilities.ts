import type { ClientCapabilities, ServerCapabilities } from 'vscode-languageserver-protocol'
import {
  WORKSPACE_EDIT_FAILURE_HANDLING,
  WORKSPACE_EDIT_RESOURCE_OPERATIONS
} from '../../../../shared/language-server-workspace-edit'

/**
 * #20 capability skew: applyEdit/documentChanges/resourceOperations reach the
 * server only from a renderer that ships the #36 guarded journal — the engine
 * and this declaration live in the same build, so a paired old client never
 * advertises edits it cannot land. Servers then keep edits inside
 * textDocument/rename replies, which are still guarded downstream.
 */
export function workspaceEditClientCapabilities(): ClientCapabilities['workspace'] {
  return {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: [...WORKSPACE_EDIT_RESOURCE_OPERATIONS],
      failureHandling: WORKSPACE_EDIT_FAILURE_HANDLING
    }
  }
}

/** Tier-1 editing surface (#37): completion/signature help, explicit
 * formatting, rename, and code actions with resolve support. */
export function semanticEditingClientCapabilities(): ClientCapabilities['textDocument'] {
  return {
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext']
      }
    },
    signatureHelp: {
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'] }
    },
    formatting: {},
    rangeFormatting: {},
    rename: {},
    codeAction: { resolveSupport: { properties: ['edit'] } }
  }
}

export type SemanticServerCapabilities = {
  completion: boolean
  completionResolve: boolean
  signatureHelp: boolean
  documentFormatting: boolean
  documentRangeFormatting: boolean
  rename: boolean
  codeAction: boolean
  codeActionResolve: boolean
  executeCommand: boolean
  /** Server-declared command ids; executeCommand requests gate on this (#20).
   * Resource operations need no read: the client capability declaration is
   * already the intersection (Orca advertises only create/rename/delete). */
  executeCommands: readonly string[]
}

/** Provider gates: intersect what the server declared with Orca's surface so
 * unsupported tiers stay disabled instead of failing per keystroke (#20). */
export function readSemanticServerCapabilities(
  server: ServerCapabilities
): SemanticServerCapabilities {
  const provider = (value: unknown): boolean => Boolean(value)
  const resolveProvider = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'resolveProvider' in value
      ? Boolean((value as { resolveProvider?: boolean }).resolveProvider)
      : false
  const executeCommandProvider = server.executeCommandProvider
  return {
    completion: provider(server.completionProvider),
    completionResolve: resolveProvider(server.completionProvider),
    signatureHelp: provider(server.signatureHelpProvider),
    documentFormatting: provider(server.documentFormattingProvider),
    documentRangeFormatting: provider(server.documentRangeFormattingProvider),
    rename: provider(server.renameProvider),
    codeAction: provider(server.codeActionProvider),
    codeActionResolve: resolveProvider(server.codeActionProvider),
    executeCommand: provider(executeCommandProvider),
    executeCommands:
      executeCommandProvider && typeof executeCommandProvider === 'object'
        ? [...(executeCommandProvider.commands ?? [])]
        : []
  }
}
