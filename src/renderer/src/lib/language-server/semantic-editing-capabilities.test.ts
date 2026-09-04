import { describe, expect, it } from 'vitest'
import type { ClientCapabilities, ServerCapabilities } from 'vscode-languageserver-protocol'
import {
  readSemanticServerCapabilities,
  semanticEditingClientCapabilities,
  workspaceEditClientCapabilities
} from './semantic-editing-capabilities'

describe('workspaceEditClientCapabilities', () => {
  it('advertises applyEdit with the guarded v1 contract', () => {
    const workspace = workspaceEditClientCapabilities()
    expect(workspace?.applyEdit).toBe(true)
    expect(workspace?.workspaceEdit).toEqual({
      documentChanges: true,
      resourceOperations: ['create', 'rename', 'delete'],
      failureHandling: 'abort'
    })
  })
})

describe('semanticEditingClientCapabilities', () => {
  it('declares the tier-1 editing surface', () => {
    expect(semanticEditingClientCapabilities()).toMatchObject({
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
    })
  })
})

describe('readSemanticServerCapabilities', () => {
  it('intersects with what the server actually declared', () => {
    const server: ServerCapabilities = {
      completionProvider: { resolveProvider: true },
      signatureHelpProvider: {},
      documentFormattingProvider: true,
      codeActionProvider: { resolveProvider: false }
    }
    expect(readSemanticServerCapabilities(server)).toEqual({
      completion: true,
      completionResolve: true,
      signatureHelp: true,
      documentFormatting: true,
      documentRangeFormatting: false,
      rename: false,
      codeAction: true,
      codeActionResolve: false,
      executeCommand: false,
      executeCommands: [],
    })
  })

  it('treats a boolean provider declaration as enabled', () => {
    const server: ServerCapabilities = {
      renameProvider: true,
      documentRangeFormattingProvider: true,
      executeCommandProvider: { commands: ['clangd.applyTweak'] }
    } as ServerCapabilities
    const caps = readSemanticServerCapabilities(server)
    expect(caps.rename).toBe(true)
    expect(caps.documentRangeFormatting).toBe(true)
    expect(caps.executeCommand).toBe(true)
    expect(caps.executeCommands).toEqual(['clangd.applyTweak'])
  })

  it('returns every capability disabled for an empty server', () => {
    expect(readSemanticServerCapabilities({})).toEqual({
      completion: false,
      completionResolve: false,
      signatureHelp: false,
      documentFormatting: false,
      documentRangeFormatting: false,
      rename: false,
      codeAction: false,
      codeActionResolve: false,
      executeCommand: false,
      executeCommands: []
    })
  })
})

describe('client capability shapes typecheck as ClientCapabilities', () => {
  it('merges into a full textDocument section', () => {
    const capabilities: ClientCapabilities = {
      textDocument: semanticEditingClientCapabilities()
    }
    expect(capabilities.textDocument).toBeDefined()
  })
})
