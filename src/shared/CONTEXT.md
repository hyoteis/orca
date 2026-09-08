# Shared domain glossary

Terms shared across Main, renderer, and remote clients. Implementation-free.

## Code intelligence scope

The single unit of C++ indexing: a named set of scope members bound to
one workspace and one execution Host. There is no distinct "aggregate scope"
kind — a workspace-relative-only scope is the degenerate case of the same
concept, not a variant. One scope, one code path. Python code intelligence
was removed (#131); ordinary Python editing stays.

## Scope member

A single filesystem path in one of two forms: relative to the workspace root,
or absolute on the execution Host. The form is a property of the path string
itself (is-absolute), not a tag.

## C++ setup pipeline

The one step sequence every C++ setup run follows: normalize scope members,
classify build roots, provision tools, generate compile-command shards
(cmake, gn, or basic), merge, and record the cached result. One
implementation for all Hosts — a Host never carries its own copy of the
sequence.

## CppSetupHost

The execution surface a setup step runs against: run a command, read and
atomically write a file, stat mtimes, list directories, resolve the scope
directory. The local filesystem and the SSH exec queue are the two
realizations; the differences between them (mtime precision, cache re-checks,
transport errors) belong to each realization, not to the pipeline.

## Managed language server

An Orca-supplied language server installed per execution Host from a trusted,
shipped manifest. Clients request manifest entry ids — never URLs or hashes.
System package managers and PATH are never touched.

## Manifest entry

One pinned artifact for one tool/version/platform/arch: source URL, archive
filename/format/size/SHA-256, glibc floor, smoke-test probe, launch command
template, and license. Entries are additive-only — activation records
reference their ids, so ids never change or disappear across releases.

## Activation record

The `active.json` file beside a tool's immutable version directories. Names
the active version and one retained rollback version; swapped atomically
(tmp + rename). Installing never mutates a running session — new sessions
pick up the newly activated version.

## Workspace-edit transaction

The guarded path every mutating semantic result takes onto the Host's files
(`language-server.workspace-edit.v1`): authorized scope/Host/path targets,
version-and-signature-checked bases, per-file atomic commits, and an
all-or-nothing journal — any failure rolls every completed file back. Its
inverse lives only in the renderer session (global undo, never persisted).

## Outline

The right-sidebar view listing the symbol tree (functions, types, variables,
…) of the currently active editor file. One Outline per active editor, not
per workspace.
_Avoid_: Struct panel, member tree (that is a Scope member directory tree), Symbols view (that is the Command-center workspace-symbol search mode)

## Heuristic symbols

Outline's degraded symbol tier: regex-extracted names and line ranges
(C++ family only) shown when no language server can run. Approximate by
definition — distinct from the semantic symbols a scope's LSP session
returns, and marked as approximate in the UI.
_Avoid_: fallback symbols

## Preimage

The on-disk content a journal step captured immediately before it ran. The
rollback, the recovery artifact (what an incomplete rollback could not
restore), and session undo all derive from preimages alone.
