# Dual Commit Semantics in Source Control

## Status

Accepted — 2026-08-20

## Context

The SCM panel redesign introduced multi-select stage+commit. Two commit scopes now coexist: everything staged (the classic flow) and exactly the files selected. One behavior cannot serve both: a selection-driven commit that silently sweeps other staged files in is surprising, and forcing users to unstage first just to scope a commit is ritual.

## Decision

Both semantics ship, each with an unambiguous trigger:

- **Selection present** — bulk action bar `Stage & Commit`, or Ctrl+Enter with a live selection: commit exactly the selected paths (pathspec semantics; untracked files are added first). Already-staged but unselected files remain staged and are excluded.
- **No selection** — primary button, or Ctrl+Enter with no selection: commit all staged content (pre-existing behavior, unchanged).

The primary button's action state machine is never influenced by the selection; the two paths share no control.

## Consequences

- Precise commit scoping without unstaging rituals.
- Two paths to learn; the UI keeps them distinct (bulk action bar vs primary button/keyboard).
- Changing either semantic after users build habits breaks trust — treat both as contracts.
