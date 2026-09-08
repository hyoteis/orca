import { createHash } from 'node:crypto'
import type { CppBuildRootDetection } from './code-intelligence-cmake-root-selection'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'
import {
  compilerArguments,
  MAX_SOURCE_FILES
} from './code-intelligence-compilation-database'
import type {
  CodeIntelligenceBasicOptions,
  CodeIntelligenceScopeMember
} from '../../shared/code-intelligence-scope'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'

/** Aggregate CDB entry — the only keys clangd consumes; everything else a
 * supplied database carried is dropped at normalization (spec §2 Step 3). */
export type AggregateCdbEntry = {
  directory: string
  file: string
  arguments?: string[]
  command?: string
}

/** Why four kinds: the dialog distinguishes them for the user — existence
 * (mount gone), JSON shape (corrupt file), and the initial-only coverage
 * check (wrong folder mapping). */
export type SuppliedCdbFailureType =
  | 'not-found'
  | 'invalid-json'
  | 'invalid-shape'
  | 'no-in-folder-commands'

/** Parses a supplied compile_commands.json text; null = not valid JSON. */
export function parseSuppliedCdbText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Shape gate: an array whose entries all carry a string `file` plus a
 * string `directory` and one of `arguments`/`command`. */
export function isValidSuppliedCdbShape(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object') {
      return false
    }
    const candidate = entry as { file?: unknown; directory?: unknown; arguments?: unknown; command?: unknown }
    return (
      typeof candidate.file === 'string' &&
      candidate.file !== '' &&
      typeof candidate.directory === 'string' &&
      (Array.isArray(candidate.arguments) || typeof candidate.command === 'string')
    )
  })
}

/** Unknown keys dropped, `arguments`/`command` verbatim, `file` resolved to a
 * host-absolute native path against its entry directory when relative. */
export function normalizeSuppliedCdbEntries(
  entries: readonly unknown[],
  detection: CppBuildRootDetection
): AggregateCdbEntry[] {
  return entries.map((entry) => {
    const candidate = entry as {
      directory: string
      file: string
      arguments?: unknown
      command?: unknown
    }
    const file = detection.isAbsolute(candidate.file)
      ? candidate.file
      : detection.resolve(candidate.directory, candidate.file)
    return {
      directory: candidate.directory,
      file,
      ...(Array.isArray(candidate.arguments) ? { arguments: [...candidate.arguments] as string[] } : {}),
      ...(typeof candidate.command === 'string' ? { command: candidate.command } : {})
    }
  })
}

/** ≥1 command whose file sits inside the mapped folder — the initial-only
 * coverage check (later failures degrade, they never re-block). */
export function hasInFolderCommand(
  entries: readonly AggregateCdbEntry[],
  workspaceRoot: string,
  memberPath: string
): boolean {
  const folderKey = normalizeRuntimePathForComparison(
    resolveMemberDirectory(workspaceRoot, memberPath)
  )
  return entries.some((entry) => {
    const key = normalizeRuntimePathForComparison(entry.file)
    return key === folderKey || key.startsWith(`${folderKey}/`)
  })
}

function resolveMemberDirectory(workspaceRoot: string, memberPath: string): string {
  if (isRuntimePathAbsolute(memberPath)) {
    return memberPath.replace(/[/]+$/, '')
  }
  if (memberPath === '.' || memberPath === '') {
    return workspaceRoot
  }
  return `${workspaceRoot.replace(/[/]+$/, '')}/${memberPath}`
}

/** Duplicate TUs resolve to one canonical entry, first-wins by scope.members
 * order (spec §2 Step 3); output sorts on the comparison key so the aggregate
 * bytes are stable for identical inputs. */
export function mergeAggregateEntries(
  shards: readonly (readonly AggregateCdbEntry[])[]
): AggregateCdbEntry[] {
  const byTu = new Map<string, AggregateCdbEntry>()
  for (const shard of shards) {
    for (const entry of shard) {
      const key = normalizeRuntimePathForComparison(entry.file)
      if (!byTu.has(key)) {
        byTu.set(key, entry)
      }
    }
  }
  return [...byTu.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, entry]) => entry)
}

export function serializeAggregateCdb(entries: readonly AggregateCdbEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

/** Stable mapping id: one supplied database may serve several non-overlapping
 * folders, so the pair (member path, database) identifies the snapshot. */
export function aggregateMappingId(memberPath: string, compileDatabase: string): string {
  return createHash('sha256').update(JSON.stringify([memberPath, compileDatabase])).digest('hex').slice(0, 16)
}

export type AggregateCdbHost = Pick<
  CppSetupHost,
  'detection' | 'readTextFile' | 'writeTextFile' | 'findSourceFiles' | 'findIncludeDirectories' | 'readableDirectories' | 'ensureDirectory'
>

/** Mapping health (#136 spec §2 Step 4): `degraded` = unreadable, the
 * last-valid snapshot is what keeps working; `warning` = readable but flawed
 * (corrupt JSON/shape, or zero in-folder coverage) — never blocks, never
 * banners; `ok` = fresh entries merged. */
export type AggregateCdbMappingState = 'ok' | 'degraded' | 'warning'

export type AggregateCdbMappingStatus = {
  id: string
  memberPath: string
  compileDatabase: string
  entryCount: number
  state: AggregateCdbMappingState
  failure?: SuppliedCdbFailureType
}

export type AggregateCdbBuildResult = {
  entryCount: number
  basicEntryCount: number
  mappings: readonly AggregateCdbMappingStatus[]
}

function failureMessage(failure: SuppliedCdbFailureType, compileDatabase: string): string {
  switch (failure) {
    case 'not-found':
      return `Compile database is not readable on this Host: ${compileDatabase}`
    case 'invalid-json':
      return `Compile database is not valid JSON: ${compileDatabase}`
    case 'invalid-shape':
      return `Compile database does not match the compile_commands.json shape: ${compileDatabase}`
    case 'no-in-folder-commands':
      return `Compile database has no commands inside its mapped folder: ${compileDatabase}`
  }
}

/** One mapping's contribution: fresh entries, or the retained snapshot when a
 * later read/parse fails (independent degradation — other mappings and the
 * supplied file itself are untouched). */
async function collectMappedEntries(
  host: AggregateCdbHost,
  args: { workspaceRoot: string; member: CodeIntelligenceScopeMember & { compileDatabase: string }; initial: boolean; mappingsDirectory: string }
): Promise<{ entries: AggregateCdbEntry[]; status: AggregateCdbMappingStatus }> {
  const { workspaceRoot, member, initial } = args
  const id = aggregateMappingId(member.path, member.compileDatabase)
  const status: AggregateCdbMappingStatus = {
    id,
    memberPath: member.path,
    compileDatabase: member.compileDatabase,
    entryCount: 0,
    state: 'ok'
  }
  let text: string
  try {
    text = await host.readTextFile(member.compileDatabase)
  } catch {
    if (initial) {
      throw new Error(failureMessage('not-found', member.compileDatabase))
    }
    const snapshot = await readSnapshot(host, args.mappingsDirectory, id)
    return {
      entries: snapshot,
      status: { ...status, entryCount: snapshot.length, state: 'degraded', failure: 'not-found' }
    }
  }
  const parsed = parseSuppliedCdbText(text)
  if (parsed === null) {
    if (initial) {
      throw new Error(failureMessage('invalid-json', member.compileDatabase))
    }
    // Readable but corrupt: the snapshot keeps the TU set working — a warning,
    // never a degradation (#136).
    const snapshot = await readSnapshot(host, args.mappingsDirectory, id)
    return {
      entries: snapshot,
      status: { ...status, entryCount: snapshot.length, state: 'warning', failure: 'invalid-json' }
    }
  }
  if (!isValidSuppliedCdbShape(parsed)) {
    if (initial) {
      throw new Error(failureMessage('invalid-shape', member.compileDatabase))
    }
    const snapshot = await readSnapshot(host, args.mappingsDirectory, id)
    return {
      entries: snapshot,
      status: { ...status, entryCount: snapshot.length, state: 'warning', failure: 'invalid-shape' }
    }
  }
  const entries = normalizeSuppliedCdbEntries(parsed, host.detection)
  if (!hasInFolderCommand(entries, workspaceRoot, member.path)) {
    if (initial) {
      throw new Error(failureMessage('no-in-folder-commands', member.compileDatabase))
    }
    // Zero in-folder coverage on a later re-merge: entries stay merged, the
    // mapping only warns.
    await host.writeTextFile(args.mappingsDirectory, `${id}.json`, serializeAggregateCdb(entries))
    return { entries, status: { ...status, entryCount: entries.length, state: 'warning', failure: 'no-in-folder-commands' } }
  }
  await host.writeTextFile(args.mappingsDirectory, `${id}.json`, serializeAggregateCdb(entries))
  return { entries, status: { ...status, entryCount: entries.length } }
}

async function readSnapshot(
  host: AggregateCdbHost,
  mappingsDirectory: string,
  id: string
): Promise<AggregateCdbEntry[]> {
  try {
    const parsed = parseSuppliedCdbText(await host.readTextFile(`${mappingsDirectory}/${id}.json`))
    return isValidSuppliedCdbShape(parsed) ? (parsed as AggregateCdbEntry[]) : []
  } catch {
    return []
  }
}

/** BASIC synthesis over one member folder — the shared options applied to
 * every discovered source file (shipped behavior, relocated to the builder). */
async function synthesizeBasicEntries(
  host: AggregateCdbHost,
  args: { workspaceRoot: string; memberPath: string; basicOptions: CodeIntelligenceBasicOptions }
): Promise<AggregateCdbEntry[]> {
  const { workspaceRoot, memberPath, basicOptions } = args
  const sourceRoot = resolveMemberDirectory(workspaceRoot, memberPath)
  const sourceFiles = await host.findSourceFiles(sourceRoot)
  if (sourceFiles.length > MAX_SOURCE_FILES) {
    throw new Error(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
  }
  if (sourceFiles.length === 0) {
    return []
  }
  const detection = host.detection
  const discoveredIncludes: string[] = []
  for (const discoveryRoot of new Set([workspaceRoot, sourceRoot])) {
    discoveredIncludes.push(...(await host.findIncludeDirectories(discoveryRoot)))
  }
  const additionalIncludes = basicOptions.includeDirectories
    .map((path) => (detection.isAbsolute(path) ? path : detection.resolve(workspaceRoot, path)))
  const includeDirectories = await host.readableDirectories([
    ...new Set([workspaceRoot, ...additionalIncludes, ...discoveredIncludes])
  ])
  const defines = basicOptions.defines.map((define) => define.trim()).filter(Boolean)
  return sourceFiles.map((file) => ({
    directory: workspaceRoot,
    file,
    arguments: compilerArguments(file, includeDirectories, defines, basicOptions.cppStandard ?? 'c++17')
  }))
}

/**
 * The aggregate builder (spec §2 Step 3, topology T1): validate each supplied
 * database, normalize entries, synthesize BASIC entries, first-wins merge by
 * scope.members order, and atomically write one Orca-owned aggregate plus
 * per-mapping last-valid snapshots. Supplied databases are never written.
 */
export async function buildAggregateCompileDatabase(args: {
  host: AggregateCdbHost
  workspaceRoot: string
  members: readonly CodeIntelligenceScopeMember[]
  basicOptions?: CodeIntelligenceBasicOptions
  scopeDirectory: string
  /** First build: full validation (incl. ≥1 in-folder command); re-merges
   * degrade a failed mapping to its last-valid snapshot instead. */
  initial: boolean
}): Promise<AggregateCdbBuildResult> {
  const mappingsDirectory = `${args.scopeDirectory.replace(/\/+$/, '')}/mappings`
  await args.host.ensureDirectory(mappingsDirectory)
  const shards: AggregateCdbEntry[][] = []
  const mappings: AggregateCdbMappingStatus[] = []
  let basicEntryCount = 0
  for (const member of args.members) {
    if (member.compileDatabase) {
      const collected = await collectMappedEntries(args.host, {
        workspaceRoot: args.workspaceRoot,
        member: member as CodeIntelligenceScopeMember & { compileDatabase: string },
        initial: args.initial,
        mappingsDirectory
      })
      shards.push(collected.entries)
      mappings.push(collected.status)
      continue
    }
    // Empty options are legal (#63 decision 6 analog): a BASIC member with
    // defaults still synthesizes entries.
    const basicOptions = args.basicOptions ?? { includeDirectories: [], defines: [] }
    const synthesized = await synthesizeBasicEntries(args.host, {
      workspaceRoot: args.workspaceRoot,
      memberPath: member.path,
      basicOptions
    })
    basicEntryCount += synthesized.length
    shards.push(synthesized)
  }
  const aggregate = mergeAggregateEntries(shards)
  await args.host.writeTextFile(args.scopeDirectory, 'compile_commands.json', serializeAggregateCdb(aggregate))
  await args.host.writeTextFile(
    args.scopeDirectory,
    'aggregate-manifest.json',
    `${JSON.stringify({ schema: 1, mappings }, null, 2)}\n`
  )
  return { entryCount: aggregate.length, basicEntryCount, mappings }
}
