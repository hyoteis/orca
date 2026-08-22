import type { CodeIntelligenceLanguage } from '../../../../shared/code-intelligence-scope'
export type CodeIntelligenceCandidate = {
  relativeRoot: string
  languages: CodeIntelligenceLanguage[]
  markers: string[]
}
const MARKERS: Record<string, CodeIntelligenceLanguage[]> = {
  'pyproject.toml': ['python'],
  'pyrightconfig.json': ['python'],
  'setup.py': ['python'],
  'compile_commands.json': ['cpp'],
  'CMakeLists.txt': ['cpp'],
  'compile_flags.txt': ['cpp']
}
export function discoverCodeIntelligenceCandidates(
  relativeFiles: readonly string[]
): CodeIntelligenceCandidate[] {
  const byRoot = new Map<
    string,
    { languages: Set<CodeIntelligenceLanguage>; markers: Set<string> }
  >()
  for (const file of relativeFiles) {
    const normalized = file.replace(/\\/g, '/'),
      name = normalized.split('/').pop() ?? '',
      languages = MARKERS[name]
    if (!languages) continue
    const root = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '.',
      entry = byRoot.get(root) ?? { languages: new Set(), markers: new Set() }
    languages.forEach((language) => entry.languages.add(language))
    entry.markers.add(name)
    byRoot.set(root, entry)
  }
  return [...byRoot]
    .map(([relativeRoot, value]) => ({
      relativeRoot,
      languages: [...value.languages].sort(),
      markers: [...value.markers].sort()
    }))
    .sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot))
}

export async function discoverCodeIntelligenceCandidatesFromHost(
  findRelativeFiles: (marker: string) => Promise<readonly string[]>
): Promise<CodeIntelligenceCandidate[]> {
  const files = (
    await Promise.all(Object.keys(MARKERS).map((marker) => findRelativeFiles(marker)))
  ).flat()
  return discoverCodeIntelligenceCandidates(files)
}
