import { spawn } from 'node:child_process'
import type { ResolvedLanguageServerCommand } from './local-language-server-session-manager'

export async function probeLocalLanguageServer(
  command: ResolvedLanguageServerCommand,
  timeoutMs = 5_000
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, '--version'], {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let retainedBytes = 0
    const collect = (chunk: Buffer): void => {
      const accepted = chunk.subarray(0, Math.max(0, 64 * 1024 - retainedBytes))
      retainedBytes += accepted.byteLength
      if (accepted.byteLength > 0) {
        chunks.push(accepted)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timed out probing local language server'))
    }, timeoutMs)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString('utf8').trim()
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(output || `Language server probe exited with code ${code}`))
      }
    })
  })
}
