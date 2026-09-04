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
// Optional canned textDocument/definition answer for jump-navigation e2e.
const definitionUri = /--definition-uri=(.+)/.exec(args.join('\n'))?.[1]
// Optional #38 drawer e2e: push a server-initiated workspace/applyEdit after
// initialization so the guarded transaction (and its preview drawer) engages.
const applyEditFile = /--apply-edit-file=(.+)/.exec(args.join('\n'))?.[1]
const applyEditNewText = /--apply-edit-new-text=(.+)/.exec(args.join('\n'))?.[1]

const sendMessage = (message) => {
  const body = Buffer.from(JSON.stringify(message))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
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
    if (message.method === undefined) {
      // A response to our own server-initiated request; nothing to answer.
      continue
    }
    if (message.id === undefined) {
      if (message.method === 'initialized' && applyEditFile && applyEditNewText) {
        if (logFile) {
          fs.appendFileSync(logFile, 'sent-applyEdit\n')
        }
        const uri = `file:///${applyEditFile.replaceAll('\\', '/')}`
        sendMessage({
          jsonrpc: '2.0',
          id: 9001,
          method: 'workspace/applyEdit',
          params: {
            edit: {
              documentChanges: [
                {
                  textDocument: { uri, version: null },
                  edits: [
                    {
                      // Whole first line; the arg parser is newline-delimited,
                      // so the replacement text itself carries no newline.
                      range: {
                        start: { line: 0, character: 0 },
                        end: { line: 1, character: 0 }
                      },
                      newText: applyEditNewText
                    }
                  ]
                }
              ]
            }
          }
        })
      }
      continue
    }
    let result
    if (message.method === 'initialize') {
      result = { capabilities: { hoverProvider: true, definitionProvider: true } }
    } else if (message.method === 'textDocument/definition' && definitionUri) {
      result = [
        {
          uri: definitionUri,
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 16 }
          }
        }
      ]
    } else {
      result = null
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
    process.stdout.write(body)
  }
})
process.stdin.on('end', () => process.exit(0))
