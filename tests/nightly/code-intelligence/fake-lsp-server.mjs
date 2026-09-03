// Minimal JSON-RPC server over stdio for lsp-roundtrip tests: initialize echo,
// hover with configurable delay, RequestCancelled on $/cancelRequest.
const HOVER_DELAY_MS = Number(process.env.FAKE_LSP_HOVER_DELAY_MS ?? '2000')
let buffer = Buffer.alloc(0)
const pending = new Map()

function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  let frame
  while ((frame = takeFrame()) !== null) {
    handleMessage(frame)
  }
})

function takeFrame() {
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd === -1) {
    return null
  }
  const match = /^Content-Length: (\d+)$/.exec(buffer.subarray(0, headerEnd).toString('utf8'))
  if (!match) {
    process.exit(3)
  }
  const length = Number(match[1])
  const totalLength = headerEnd + 4 + length
  if (buffer.length < totalLength) {
    return null
  }
  const body = JSON.parse(buffer.subarray(headerEnd + 4, totalLength).toString('utf8'))
  buffer = buffer.subarray(totalLength)
  return body
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } })
    return
  }
  if (message.method === 'initialized') {
    return
  }
  if (message.method === '$/cancelRequest') {
    const entry = pending.get(message.params.id)
    if (entry && !entry.settled) {
      entry.settled = true
      clearTimeout(entry.timer)
      send({ jsonrpc: '2.0', id: entry.id, error: { code: -32800, message: 'Request cancelled' } })
    }
    return
  }
  if (message.method === 'textDocument/hover' || message.method === 'ping/hover') {
    const entry = { id: message.id, settled: false }
    pending.set(message.id, entry)
    entry.timer = setTimeout(() => {
      if (entry.settled) {
        return
      }
      entry.settled = true
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { contents: { kind: 'plaintext', value: 'fake' } }
      })
    }, HOVER_DELAY_MS)
    return
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null })
  }
}
