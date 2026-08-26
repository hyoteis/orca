import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CppSetupCommandRunner } from './code-intelligence-cpp-setup-tools'

const WINDOWS_GN_PACKAGE_URL =
  'https://chrome-infra-packages.appspot.com/dl/gn/gn/windows-amd64/+/latest'
const MAX_GN_PACKAGE_BYTES = 64 * 1024 * 1024

type FetchResponse = {
  ok: boolean
  status: number
  arrayBuffer: () => Promise<ArrayBuffer>
}
type FetchGnPackage = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>

function cachedGnExecutable(cacheRoot: string): string {
  return join(cacheRoot, 'tools', 'gn', 'windows-amd64', 'gn.exe')
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function assertInside(parent: string, candidate: string): void {
  const path = relative(resolve(parent), resolve(candidate))
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error('GN installer temporary path resolved outside the tool cache')
  }
}

async function defaultFetch(url: string, init: { signal: AbortSignal }): Promise<FetchResponse> {
  const { net } = await import('electron')
  return net.fetch(url, init)
}

export async function discoverCachedWindowsGn(
  cacheRoot: string,
  platform: NodeJS.Platform,
  arch: string = process.arch
): Promise<string | null> {
  if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) {
    return null
  }
  const executable = cachedGnExecutable(cacheRoot)
  return (await isExecutable(executable)) ? executable : null
}

export async function installCachedWindowsGn(args: {
  cacheRoot: string
  platform: NodeJS.Platform
  arch?: string
  run: CppSetupCommandRunner
  logs: string[]
  fetchPackage?: FetchGnPackage
}): Promise<string> {
  const arch = args.arch ?? process.arch
  if (args.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Automatic GN installation is unavailable for ${args.platform}-${arch}`)
  }
  const destination = cachedGnExecutable(args.cacheRoot)
  if (await isExecutable(destination)) {
    return destination
  }
  const temporaryRoot = join(args.cacheRoot, `.gn-install-${randomUUID()}`)
  assertInside(args.cacheRoot, temporaryRoot)
  const archivePath = join(temporaryRoot, 'gn.zip')
  const extractPath = join(temporaryRoot, 'extract')
  try {
    await mkdir(extractPath, { recursive: true })
    const response = await (args.fetchPackage ?? defaultFetch)(WINDOWS_GN_PACKAGE_URL, {
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) {
      throw new Error(`Official GN package download failed with HTTP ${response.status}`)
    }
    const archive = Buffer.from(await response.arrayBuffer())
    if (archive.byteLength === 0 || archive.byteLength > MAX_GN_PACKAGE_BYTES) {
      throw new Error('Official GN package size is invalid')
    }
    await writeFile(archivePath, archive)
    const extractResult = await args.run(
      'tar.exe',
      ['-xf', archivePath, '-C', extractPath],
      args.cacheRoot
    )
    if (extractResult.code !== 0) {
      throw new Error(`Could not extract the official GN package: ${extractResult.output.trim()}`)
    }
    const extractedExecutable = join(extractPath, 'gn.exe')
    if (!(await isExecutable(extractedExecutable))) {
      throw new Error('The official GN package did not contain gn.exe')
    }
    await mkdir(join(args.cacheRoot, 'tools', 'gn', 'windows-amd64'), { recursive: true })
    await rm(destination, { force: true })
    await rename(extractedExecutable, destination)
    args.logs.push(`\n## Install GN\nDownloaded the official GN package to ${destination}`)
    return destination
  } catch (error) {
    throw new Error(
      `Automatic GN installation failed. Check the network/proxy and retry. ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
