import type * as Monaco from 'monaco-editor'
import { isDefinitionModifierPressed, installDefinitionLinkAffordance } from './definition-link-affordance'
import {
  openCppDefinitionTarget,
  resolveCppDefinition,
  type CppCodeIntelligenceRequest
} from './cpp-definition-navigation'

export const isCppDefinitionModifierPressed = isDefinitionModifierPressed

export function installCppDefinitionLinkAffordance(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: (position: Monaco.IPosition) => CppCodeIntelligenceRequest | null
): () => void {
  return installDefinitionLinkAffordance(monaco, editor, requestAt, {
    resolve: resolveCppDefinition,
    open: openCppDefinitionTarget
  })
}
