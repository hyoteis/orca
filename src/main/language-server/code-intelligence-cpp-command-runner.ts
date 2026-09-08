import { spawn } from 'node:child_process'

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LOG_BYTES = 1024 * 1024

export type CppSetupCommandResult = { code: number | null; output: string }
export type CppSetupCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) => Promise<CppSetupCommandResult>

/** Spawn with a hard timeout and a byte-capped combined log (managed-install seam). */
export function runCppSetupCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CppSetupCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let retained = 0
    const collect = (chunk: Buffer): void => {
      const accepted = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - retained))
      retained += accepted.byteLength
      if (accepted.byteLength > 0) {
        chunks.push(accepted)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveResult({ code: null, output: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveResult({ code, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}
