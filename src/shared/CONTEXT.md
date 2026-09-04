# Shared domain glossary

Terms shared across Main, renderer, and remote clients. Implementation-free.

## Code intelligence scope

The single unit of C++/Python indexing: a named set of scope members bound to
one workspace and one execution Host. There is no distinct "aggregate scope"
kind — a workspace-relative-only scope is the degenerate case of the same
concept, not a variant. One scope, one code path.

## Scope member

A single filesystem path in one of two forms: relative to the workspace root,
or absolute on the execution Host. The form is a property of the path string
itself (is-absolute), not a tag. Python scopes accept the relative form only.

## Managed language server

An Orca-supplied language server installed per execution Host from a trusted,
shipped manifest. Clients request manifest entry ids — never URLs or hashes.
Managed Python servers carry a private managed Node runtime instead of the
user's Node; system package managers and PATH are never touched.

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

## Preimage

The on-disk content a journal step captured immediately before it ran. The
rollback, the recovery artifact (what an incomplete rollback could not
restore), and session undo all derive from preimages alone.
