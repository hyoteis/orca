import type { Definition, Location, LocationLink, Range } from 'vscode-languageserver-protocol'

export type CppDefinitionTarget = { uri: string; range: Range }

function locationTarget(value: Location | LocationLink): CppDefinitionTarget {
  return 'targetUri' in value
    ? { uri: value.targetUri, range: value.targetSelectionRange }
    : { uri: value.uri, range: value.range }
}

export function definitionTargets(
  definition: Definition | LocationLink[] | null
): CppDefinitionTarget[] {
  if (!definition) {
    return []
  }
  return (Array.isArray(definition) ? definition : [definition]).map(locationTarget)
}
