import {
  coalesceCmakeBuildRoots,
  cppUpwardSearchBound,
  detectCppBuildRoot,
  localCppBuildRootDetection,
  type CppBuildRoot,
  type CppBuildRootDetection
} from './code-intelligence-cmake-root-selection'
import { findGnRoot } from './code-intelligence-gn-output'

/** Single-source member classification shared by local and SSH setups: detection,
 * form-boundary cmake coalescing, .gn upward search, and the basic-root fallback. */
export async function classifyCppBuildRoots(
  workspaceRoot: string,
  members: readonly string[],
  detection: CppBuildRootDetection = localCppBuildRootDetection
): Promise<{
  buildRoots: CppBuildRoot[]
  gnRootBySource: Map<string, string | null>
  basicSourceRoots: string[]
}> {
  const detectedRoots = await Promise.all(
    members.map((member) => detectCppBuildRoot(workspaceRoot, member, detection))
  )
  const buildRoots = await coalesceCmakeBuildRoots(workspaceRoot, detectedRoots, detection)
  // GN upward search is bounded by the member's form: relative members stop
  // at the workspace root, absolute members at the filesystem root.
  const gnRootBySource = new Map<string, string | null>(
    await Promise.all(
      buildRoots
        .filter((root) => root.system === 'gn')
        .map(async (root) => [
          root.sourceDir,
          await findGnRoot(cppUpwardSearchBound(root, workspaceRoot), root.sourceDir, detection)
        ] as const)
    )
  )
  const basicSourceRoots = buildRoots
    .filter(
      (root) => root.system === 'basic' || (root.system === 'gn' && !gnRootBySource.get(root.sourceDir))
    )
    .map((root) => root.sourceDir)
  return { buildRoots, gnRootBySource, basicSourceRoots }
}
