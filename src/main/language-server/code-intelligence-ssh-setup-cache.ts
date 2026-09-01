import { posix } from 'node:path'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import {
  SETUP_MANIFEST_FILE,
  codeIntelligenceSetupFingerprintDigest,
  parseCachedCodeIntelligenceSetupResult
} from './code-intelligence-setup-cache'
import {
  buildRemoteMtimesCommand,
  buildRemoteReadablePathCommand,
  buildRemoteReadFileCommand,
  type SshSetupExecQueue
} from './code-intelligence-ssh-setup-exec'

/** Remote fingerprint via one stat batch; null when the answer does not line
 * up with the probe list (cache silently skipped). Seconds-precision mtimes
 * (vs the local mtimeMs) are fine: the two caches never cross-compare. */
export async function remoteSetupFingerprint(
  queue: SshSetupExecQueue,
  args: {
    repoId: string
    roots: readonly string[]
    request: CodeIntelligenceCppSetupRequest
    buildRoots: readonly { sourceDir: string; system: 'cmake' | 'gn' | 'basic' }[]
    uname: string
  }
): Promise<string | null> {
  const paths = args.buildRoots.flatMap((root) => [
    root.sourceDir,
    posix.join(root.sourceDir, 'CMakeLists.txt'),
    posix.join(root.sourceDir, 'BUILD.gn'),
    posix.join(root.sourceDir, '.gn')
  ])
  const result = await queue.exec(buildRemoteMtimesCommand(paths, args.uname))
  if (result.code !== 0) {
    return null
  }
  const mtimes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
  if (mtimes.length !== paths.length || mtimes.some((mtime) => !Number.isFinite(mtime))) {
    return null
  }
  const buildInputs = args.buildRoots.map((root, index) => {
    const [directoryModifiedAt, cmakeModifiedAt, gnModifiedAt, dotGnModifiedAt] = mtimes.slice(
      index * 4,
      index * 4 + 4
    )
    return {
      path: root.sourceDir,
      system: root.system,
      directoryModifiedAt,
      cmakeModifiedAt,
      gnModifiedAt,
      dotGnModifiedAt
    }
  })
  return codeIntelligenceSetupFingerprintDigest({
    repoId: args.repoId,
    roots: args.roots,
    request: args.request,
    buildInputs
  })
}

/** Cache validation drops the local X_OK re-check: a moved clangd fails at spawn. */
export async function readRemoteCachedSetupResult(
  queue: SshSetupExecQueue,
  scopeDirectory: string,
  fingerprint: string
): Promise<CodeIntelligenceCppSetupResult | null> {
  const manifest = await queue.exec(
    buildRemoteReadFileCommand(posix.join(scopeDirectory, SETUP_MANIFEST_FILE))
  )
  if (manifest.code !== 0) {
    return null
  }
  const cached = parseCachedCodeIntelligenceSetupResult(manifest.stdout, fingerprint)
  if (!cached) {
    return null
  }
  const readable = await queue.exec(
    buildRemoteReadablePathCommand(posix.join(scopeDirectory, 'compile_commands.json'))
  )
  return readable.code === 0 ? cached : null
}
