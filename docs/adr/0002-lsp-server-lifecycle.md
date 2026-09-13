# LSP server lifecycle rides the relay grace clock; the execution host enforces single-server exclusivity

ADR 0001 left the language server's `live`/`unverifiable`/`exited` mapping and idle policy to #175. We decided the detached remote server is retained on the **same relay grace clock as terminals** — one user-facing setting, one kill round, no LSP-specific timer — and that **at most one language server may hold a workspace's index directory per execution host**, enforced by the supervisor on that host: before spawning it takes a workspace server lock, and a lock held by a *verified predecessor* (pid + `/proc` cmdline + start-time + Orca argv fingerprint) is deliberately stopped by the new supervisor — killer and killed share a host, so the evidence discipline of `docs/reference/ssh-execution-boundary.md` holds. A lock held by a foreign server (the user's own editor clangd) is never killed; spawn is blocked and surfaced as a degraded state. Resume-vs-cold is decided only by the supervisor's attach answer: incarnation match → resume; proven predecessor exit → `exited` + attach the new incarnation; unmarked not-found → `unverifiable` + cold spawn (an additive marker mirroring `PTY_ATTACH_PROVEN_EXITED_MARKER`; a missing marker is never evidence). Local servers observe exits directly (`exited`, no ambiguity): restart with 1s/2s/4s backoff, three consecutive failures → syntax-only degradation with a manual retry, while spawn/initialize failures go to the #164 negative cache with no auto-retry. While detached, the supervisor observes but does not deliver `$/progress` (last token per session buffered) and synthesizes a `begin` on resume.

## Considered Options

- **LSP-specific idle timer (optionally activity-aware, paused while stdio is busy)** — rejected: a second clock users must reason about, asymmetric with the terminal promise ("my terminal lived, why did my server die?"). Memory pressure from lingering servers is bounded by #185's per-host instance caps instead.
- **Never touch predecessors** — rejected: a crashed or upgraded-away daemon strands a 1–3 GB clangd forever, and the next spawn becomes a second concurrent writer of `.cache/clangd/index/`.
- **Accept dual runners** — rejected: concurrent shard writers have undefined behavior.
- **Teaching the superseded-relay sweep about LSP-only husks** — rejected: once the lock disposes the stranded server, the old daemon becomes an empty husk the existing sweep already reaps (`src/main/ssh/ssh-relay-superseded-endpoints.ts`).
- **Joining the tty-shaped orphan sweep** — rejected: its evidence unit is process groups on a tty; a language server has no tty. The supervisor owns every kill.

## Consequences

- Under the default grace `0` (keep until reset), a detached clangd stays resident (1–3 GB) for exactly as long as the user's terminals would — accepted, same promise; OS paging applies.
- Grace expiry kills the server and the daemon exits (`src/relay/relay-grace-lifecycle.ts` shutdown path), so a later attach can never reach positive evidence: the verdict is `unverifiable` and the client cold-spawns. A daemon crash and a bundle-hash upgrade (exit 42) land identically — three host scenarios, one client action, no tombstones needed.
- Load-bearing spec fact: `isRelayIdle()` counts only PTYs (`src/relay/relay-grace-lifecycle.ts:154-159`); LSP sessions must count into the non-idle predicate, or a PTY-less daemon idle-exits and kills the server it holds.
- The client never infers server death from transport failure; `superseded` (lease lost to a newer attach) is not a verdict — the server stays `live` under the new writer.

Detail and evidence: #175 (vocabulary mapping table + client state machine); base architecture: ADR 0001.
