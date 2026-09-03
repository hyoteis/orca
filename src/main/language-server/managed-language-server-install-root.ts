import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedLanguageServerActivationRecord } from '../../shared/managed-language-server'
import type {
  ManagedLanguageServerManifest,
  ManagedLanguageServerManifestEntry
} from '../../shared/managed-language-server'

export const MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE = 'active.json'

/** Local layout: <userData>/code-intelligence/managed/<tool>/<version> with an
 * activation record beside the immutable version directories. */
export function managedToolRoot(root: string, tool: string): string {
  return join(root, tool)
}

export function managedVersionDirectory(root: string, tool: string, version: string): string {
  return join(root, tool, version)
}

export function managedStagingDirectory(toolRoot: string): string {
  return join(toolRoot, `.${randomUUID()}.staging`)
}

export function managedActivationPath(toolRoot: string): string {
  return join(toolRoot, MANAGED_LANGUAGE_SERVER_ACTIVATION_FILE)
}

export function manifestEntryById(
  manifest: ManagedLanguageServerManifest,
  entryId: string
): ManagedLanguageServerManifestEntry | undefined {
  return manifest.entries.find((entry) => entry.id === entryId)
}

export async function readManagedActivation(
  toolRoot: string
): Promise<ManagedLanguageServerActivationRecord | null> {
  try {
    const record = JSON.parse(
      await readFile(managedActivationPath(toolRoot), 'utf8')
    ) as ManagedLanguageServerActivationRecord
    if (typeof record?.active?.version !== 'string') {
      return null
    }
    return record
  } catch {
    return null
  }
}

/** Atomic activation swap: tmp + rename in the same directory, so a crash
 * mid-write never leaves a half-written active record. */
export async function writeManagedActivation(
  toolRoot: string,
  record: ManagedLanguageServerActivationRecord
): Promise<void> {
  const temporary = `${managedActivationPath(toolRoot)}.tmp`
  await writeFile(temporary, JSON.stringify(record, null, 2))
  await rename(temporary, managedActivationPath(toolRoot))
}

/** Version directories present under the tool root (staging dot-dirs excluded). */
export async function listManagedVersions(toolRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(toolRoot, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
}

export async function removeManagedStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true })
}
