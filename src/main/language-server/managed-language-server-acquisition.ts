import { chmod, mkdir, rename } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  resolveManagedLanguageServerCommand
} from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerInstallPhase,
  ManagedLanguageServerInstallRoute,
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'
import type { CppSetupCommandRunner } from './code-intelligence-cpp-setup-tools'
import { buildManagedExtractionCommands } from './managed-language-server-extraction'
import type { FetchManagedArchive } from './managed-language-server-archive'
import { writeVerifiedManagedArchive } from './managed-language-server-archive'
import {
  managedStagingDirectory,
  managedToolRoot,
  managedVersionDirectory,
  removeManagedStaging
} from './managed-language-server-install-root'

/** Probe/extraction tail length in error messages (shared with the SSH mirror). */
export const PROBE_LOG_LIMIT = 200

/** Local Host target for entry matching; probes glibc once on linux. */
export async function resolveLocalManagedHostTarget(
  run: CppSetupCommandRunner
): Promise<{ platform: string; arch: string; glibcVersion?: string }> {
  if (process.platform !== 'linux') {
    return { platform: process.platform, arch: process.arch }
  }
  return { platform: process.platform, arch: process.arch, glibcVersion: await detectGlibcVersion(run) }
}

/** `ldd --version` first line carries the glibc version; failure = unknown. */
async function detectGlibcVersion(run: CppSetupCommandRunner): Promise<string | undefined> {
  const result = await run('ldd', ['--version'], process.cwd())
  return result.output.match(/\b(2\.\d+(?:\.\d+)?)\b/)?.[1]
}

export type ManagedAcquisitionSeams = {
  run: CppSetupCommandRunner
  fetchArchive?: FetchManagedArchive
  emit: (
    entry: ManagedLanguageServerManifestEntry,
    phase: ManagedLanguageServerInstallPhase,
    extra?: { receivedBytes?: number; totalBytes?: number }
  ) => void
}

/** Runtime version root for entries that carry a private Node dependency. */
export function managedRuntimeRoot(
  root: string,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry
): string | undefined {
  const runtimeEntry = entry.runtimeEntryId
    ? manifest.entries.find((candidate) => candidate.id === entry.runtimeEntryId)
    : undefined
  return runtimeEntry
    ? managedVersionDirectory(root, runtimeEntry.tool, runtimeEntry.version)
    : undefined
}

/**
 * Stage → hash-verify → extract → smoke-test → atomic adopt of one immutable
 * version directory (#15 transaction). Staging is removed in every outcome;
 * no failure path here can touch an installed or active version.
 */
export async function acquireManagedVersion(args: {
  root: string
  manifest: ManagedLanguageServerManifest
  entry: ManagedLanguageServerManifestEntry
  runtimeEntry?: ManagedLanguageServerManifestEntry
  route: ManagedLanguageServerInstallRoute
  signal: AbortSignal
  seams: ManagedAcquisitionSeams
}): Promise<void> {
  const { entry } = args
  const toolRoot = managedToolRoot(args.root, entry.tool)
  await mkdir(toolRoot, { recursive: true })
  const staging = managedStagingDirectory(toolRoot)
  try {
    const extractDirectory = join(staging, 'extract')
    await mkdir(extractDirectory, { recursive: true })
    const archivePath = join(staging, entry.archiveFileName)
    const runtimeRoot = args.runtimeEntry
      ? managedVersionDirectory(args.root, args.runtimeEntry.tool, args.runtimeEntry.version)
      : managedRuntimeRoot(args.root, args.manifest, entry)
    await writeVerifiedManagedArchive({
      entry,
      route: args.route,
      destination: archivePath,
      fetchArchive: args.seams.fetchArchive,
      signal: args.signal,
      onProgress: (receivedBytes, totalBytes) =>
        args.seams.emit(
          entry,
          args.route.type === 'host-download' ? 'download' : 'upload',
          { receivedBytes, totalBytes }
        )
    })
    args.signal.throwIfAborted()
    args.seams.emit(entry, 'extract')
    const extracted = await extractManagedArchive(entry, archivePath, extractDirectory, args.seams.run)
    assertInsideStaging(extractDirectory, extracted)
    await prepareProbeExecutable(entry, extracted, runtimeRoot)
    args.seams.emit(entry, 'probe')
    await probeManagedEntry(args.root, args.manifest, entry, extracted, args.seams.run)
    args.seams.emit(entry, 'activate')
    const destination = managedVersionDirectory(args.root, entry.tool, entry.version)
    try {
      await rename(extracted, destination)
    } catch {
      // Version directory already present from a prior install: verify it
      // instead of replacing it (immutability beats re-extraction).
      if (!(await isProbingManagedVersion(args.root, args.manifest, entry, args.seams.run))) {
        throw new Error(`Existing managed ${entry.tool} ${entry.version} failed its smoke test`)
      }
    }
  } finally {
    await removeManagedStaging(staging)
  }
}

async function extractManagedArchive(
  entry: ManagedLanguageServerManifestEntry,
  archivePath: string,
  destination: string,
  run: CppSetupCommandRunner
): Promise<string> {
  const commands = buildManagedExtractionCommands({
    platform: process.platform,
    archiveFormat: entry.archiveFormat,
    archivePath,
    destination
  })
  let lastOutput = ''
  for (const command of commands) {
    const result = await run(command.executable, command.args, destination)
    if (result.code === 0) {
      return entry.archiveRootDirectory === '.'
        ? destination
        : join(destination, entry.archiveRootDirectory)
    }
    lastOutput = result.output.trim()
  }
  throw new Error(`Archive extraction failed: ${lastOutput.slice(0, PROBE_LOG_LIMIT)}`)
}

/** Smoke test an installed (or freshly extracted) version; non-zero exit aborts. */
export async function probeManagedEntry(
  root: string,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry,
  rootDirectory: string,
  run: CppSetupCommandRunner
): Promise<void> {
  const command = resolveManagedLanguageServerCommand(entry.probe, {
    root: rootDirectory,
    runtimeRoot: managedRuntimeRoot(root, manifest, entry)
  })
  const result = await run(command.executable, command.args, rootDirectory)
  if (result.code !== 0) {
    throw new Error(
      `Managed ${entry.tool} ${entry.version} smoke test failed: ${result.output.slice(0, PROBE_LOG_LIMIT)}`
    )
  }
}

export async function isProbingManagedVersion(
  root: string,
  manifest: ManagedLanguageServerManifest,
  entry: ManagedLanguageServerManifestEntry,
  run: CppSetupCommandRunner
): Promise<boolean> {
  const versionDirectory = managedVersionDirectory(root, entry.tool, entry.version)
  try {
    await (await import('node:fs/promises')).access(versionDirectory)
  } catch {
    return false
  }
  try {
    await probeManagedEntry(root, manifest, entry, versionDirectory, run)
    return true
  } catch {
    return false
  }
}

/** python3 -m zipfile loses the executable bit; chmod the probe target so
 * the smoke test measures the archive, not the extractor's mode handling. */
async function prepareProbeExecutable(
  entry: ManagedLanguageServerManifestEntry,
  rootDirectory: string,
  runtimeRoot: string | undefined
): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const command = resolveManagedLanguageServerCommand(entry.probe, {
    root: rootDirectory,
    runtimeRoot
  })
  if (isAbsolute(command.executable)) {
    await chmod(command.executable, 0o755)
  }
}

function assertInsideStaging(parent: string, candidate: string): void {
  const relativePath = relative(resolve(parent), resolve(candidate))
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Managed archive extracted outside its staging directory')
  }
}
