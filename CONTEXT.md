# Orca

Orca is an Electron coding harness: a local editor and agent surface over workspaces whose execution lives either on the local machine or on an SSH host.

## Language

### LSP integration

**LSP supervisor**:
The relay-daemon component that owns a remote language server process and its `initialize` handshake, tracks the open-document set, and leases the session to one attached client at a time.
_Avoid_: thin proxy, remote agent, LSP daemon

**LSP session channel**:
The relay JSON-RPC method family carrying LSP messages between the client core and a supervisor-held language server.
_Avoid_: LSP tunnel, LSP opcode stream

**Client core**:
The single LSP client implementation in the Electron main process, shared by local and remote workspaces above a message-level transport.
_Avoid_: remote client, editor client

**Attach / Resume / Supersede**:
Attach claims a supervisor session; resume attaches to the same server incarnation (warm); supersede is a newer attach taking over the lease from the previous client.
_Avoid_: reconnect (transport-level, ambiguous), re-attach (use resume)

**Session identity**:
The triple naming a supervisor session: the workspace session, the server incarnation (which process generation), and the client generation (which attach lease).


**Server source**:
The resolved origin of a session's server binary: an explicit user-set path, an automatically probed absolute path from the execution host, or the unresolved outcomes missing / unverifiable. Orthogonal to the process lifecycle states (live / unverifiable / exited), which describe a running session's process, not how its binary was found; an unverifiable probe never counts as missing.
_Avoid_: server detection, discovery

**Predecessor**:
A language server process left on the execution host by an earlier supervisor generation, through a daemon crash or an upgrade. Only the execution host can verify or stop it.
_Avoid_: orphan server, zombie

**Workspace server lock**:
The execution-host guarantee that at most one language server instance holds a workspace's index directory at a time, enforced by the supervisor on that host from process-table evidence.
_Avoid_: singleton, mutex

**Degraded (last-valid)**:
The C++ scope state where the attached compile database has gone missing or unreadable, but the last-valid aggregated copy still feeds the running clangd, so semantic features continue. Presented as a dismissible notice; recovery on restore is silent.
_Avoid_: broken CDB, fallback mode

**Syntax-only**:
The C++ scope state where no semantic session is in effect — no compile database, capacity refusal, a superseded lease, the server out of restarts, a server missing on the execution host, or a server version below the supported floor — so cross-file features are withdrawn rather than blank. Presented as a non-dismissible banner naming the cause; never presented as semantic. Bare-server causes keep parse-level feedback; no-server causes show the banner only.
_Avoid_: degraded (that is the last-valid state), dummy mode
**Catalog entry (verified / unverified)**:
The lifecycle state of a language-catalog record. Verified: the entry passed Orca's acceptance trio for that server and is user-enableable. Unverified: mined from upstream data, never exercised in Orca, and hidden from the enablement UI. _Avoid_: supported/unsupported (that is what the limits field declares).

**Not-attached**:
The editor state where root detection found no marker up the ancestor chain, so no LSP session is started at all. Distinct from Syntax-only: there is no server whose features need withdrawing; the status strip names the absence. _Avoid_: detached, no-root mode
