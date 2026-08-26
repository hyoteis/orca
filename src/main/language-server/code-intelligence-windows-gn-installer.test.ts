import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverCachedWindowsGn,
  installCachedWindowsGn
} from './code-intelligence-windows-gn-installer'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Windows GN installer', () => {
  it('downloads the official package into Orca tool cache', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'orca-gn-installer-'))
    tempDirs.push(cacheRoot)
    const fetchPackage = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    })
    const run = vi.fn(async (_executable: string, commandArgs: readonly string[]) => {
      const extractPath = commandArgs[commandArgs.indexOf('-C') + 1]
      await mkdir(extractPath, { recursive: true })
      const executable = join(extractPath, 'gn.exe')
      await writeFile(executable, 'gn')
      await chmod(executable, 0o755)
      return { code: 0, output: '' }
    })
    const logs: string[] = []

    const executable = await installCachedWindowsGn({
      cacheRoot,
      platform: 'win32',
      arch: 'x64',
      run,
      logs,
      fetchPackage
    })

    expect(fetchPackage).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('tar.exe', expect.arrayContaining(['-xf', '-C']), cacheRoot)
    await expect(discoverCachedWindowsGn(cacheRoot, 'win32', 'x64')).resolves.toBe(executable)
    expect(logs.join('\n')).toContain('Downloaded the official GN package')
  })
})
