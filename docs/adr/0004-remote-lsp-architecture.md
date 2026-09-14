# Remote LSP runs as daemon-held sessions over an `lsp.*` relay channel

Orca's editor needs LSP intelligence for SSH workspaces at LLVM scale (~100k-file C++), where the language server must run on the execution host (`docs/reference/ssh-execution-boundary.md`). Research (#171 relay inventory, #172 clangd budget) showed the LSP `initialize` handshake is once-per-process, so a reconnecting client can never re-initialize a live server: a raw stdio tunnel forces a cold respawn on every WAN flake, app restart, or sleep/wake, while a full remote client port saves no WAN bytes because the Monaco renderer is local regardless. We decided on a **daemon-side LSP supervisor**: the relay daemon spawns and owns the language server process, performs `initialize` once (forwarding the first client handshake, then answering later ones from its cached result), tracks the open-document set (synthesizing `didClose` on detach), and leases the session to one attached client at a time. The single LSP client implementation lives in the Electron main process above a message-level transport interface — local workspaces use a streaming stdio subprocess, remote workspaces use a new `lsp.*` JSON-RPC method family negotiated `pty.openClient`-style (`protocolVersion` + `capabilities`) at attach.

## Considered Options

- **Dumb stdio tunnel (A0)** — rejected: a live clangd stranded by a disconnect cannot be re-initialized by the next client, so every reconnect re-pays preamble build per open file (1–11s, llvm#213349), and remote language servers would die on disconnect while remote terminals survive — inverting Orca's existing promise.
- **Full remote client, vscode-remote style (B)** — rejected: the client core would deploy twice (local workspaces have no daemon), require a purpose-built editor-intelligence protocol to negotiate and version, and move zero bytes off the WAN — hover/completion/diagnostics data must reach the local renderer either way.
- **New relay frame opcode** — rejected: unknown frame types are silently dropped by older peers (wire Rule 2) and frame changes must be mirrored across the hand-maintained `protocol.ts` pair; an unknown JSON-RPC method fails loudly with `-32601` instead.
- **Reusing the PTY channel** — rejected on terminal semantics (ONLCR rewrites `\n` and corrupts `Content-Length` byte counts).
- **Generic `proc.*` subprocess channel** — rejected: the supervisor must understand LSP document-sync semantics anyway (didClose synthesis on detach); a "neutral" channel would grow LSP special cases.

## Consequences

- Upgrade is always a session reset: any relay change bumps the bundle hash and strands the old daemon with its language server as `unverifiable`. Accepted as invariant; index shards on the execution host survive and refill warm state after the new daemon respawns the server.
- Warm resume is best-effort at file granularity: the background index continues while detached unconditionally, but preamble warmth survives only within clangd's bounded MRU cache.
- Server→client LSP notifications ride the bulk lane (never control: overflow there is fatal; never naked ordinary: overflow there drops silently). They are dropped while no client is attached; recovery is client-driven (`didOpen` re-triggers `publishDiagnostics`), never server replay. Requests ride the control lane; responses over 256KiB stream `responseChunk`-style.
- `exit` from the client is an explicit stop — the supervisor terminates the server. A transport disconnect is not `exit`; idle/kill policy and the `live`/`unverifiable`/`exited` mapping are tracked in #175.

Detail and evidence: #174; research branches `research/relay-lsp-transport` (#171) and `research/clangd-llvm-scale` (#172).
