# Domain Docs

This repository uses a multi-context domain-documentation layout.

## Before exploring

1. Read root `CONTEXT-MAP.md` when it exists.
2. Follow it to every `CONTEXT.md` relevant to the task.
3. Read relevant system-wide ADRs under `docs/adr/`.
4. Read context-specific ADRs under the context?s `docs/adr/`.

If a context file does not exist yet, proceed silently. `/domain-modeling`, `/grill-with-docs`, and `/improve-codebase-architecture` create domain documentation lazily when terminology or decisions are actually resolved.

## Context layout

`CONTEXT-MAP.md` is the directory of contexts. Expected context locations include:

- `src/main/CONTEXT.md` ? Electron Main and local execution authority
- `src/preload/CONTEXT.md` ? renderer/Main security and IPC contract
- `src/renderer/CONTEXT.md` ? desktop renderer and UI
- `src/shared/CONTEXT.md` ? shared domain and wire contracts
- `src/relay/CONTEXT.md` ? relay/runtime host behavior
- `src/cli/CONTEXT.md` ? CLI behavior
- `mobile/CONTEXT.md` ? mobile client

Only add a context to `CONTEXT-MAP.md` once its `CONTEXT.md` exists.

System-wide decisions remain in `docs/adr/`. Context-specific decisions belong under `<context>/docs/adr/`.

## Vocabulary

Use terms exactly as defined by the relevant `CONTEXT.md`. Avoid introducing synonyms for established concepts in issue titles, tests, implementation plans, and code.

If a needed concept is missing, either reconsider whether it is genuine project language or record the gap for `/domain-modeling`.

## ADR conflicts

If proposed work contradicts an ADR, surface the conflict explicitly rather than silently overriding it:

> Contradicts ADR-0001, but worth reopening because?
