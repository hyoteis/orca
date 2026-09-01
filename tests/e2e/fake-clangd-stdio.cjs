#!/usr/bin/env node
// Minimal clangd stand-in for e2e: speaks enough LSP over stdio for Orca's
// client to open a session, and appends its pid to the --pid-log file on every
// process start so a spec can prove the session survived a scope edit
// (one line per spawn).
const fs = require('node:fs')

const args = process.argv.slice(2)
const logFile = /--pid-log=(.+)/.exec(args.join('\n'))?.[1]
if (logFile) {
  fs.appendFileSync(logFile, `${process.pid}\n`)
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return
    }
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd))?.[1])
    if (buffer.length < headerEnd + 4 + length) {
      return
    }
    const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length))
    buffer = buffer.slice(headerEnd + 4 + length)
    if (message.id === undefined) {
      continue
    }
    const result =
      message.method === 'initialize'
        ? { capabilities: { hoverProvider: true, definitionProvider: true } }
        : null
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
    process.stdout.write(body)
  }
})
process.stdin.on('end', () => process.exit(0))
