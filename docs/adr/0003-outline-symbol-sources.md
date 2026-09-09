# Outline symbol sources: scope LSP first, auto default scope, heuristic fallback

The Outline view (symbol tree of the active editor file) gets its data in
tiers: a code-intelligence scope's LSP session when one covers the file;
otherwise an auto-created default scope (whole worktree root) on local hosts
so outline works zero-config; otherwise a regex-based heuristic extraction —
C++ family only, marked "approximate" — when no LSP can run (SSH host
unconfigured, scope creation failed, or the user deleted the auto scope).
This keeps the one-session-per-scope model (#12) intact instead of a second
session track, and honors the product promise that outline shows something
even before any scope is configured.

## Considered Options

- **Out-of-scope transient LSP sessions** (one clangd per outline file,
  bypassing scope config): rejected — a second session lifecycle forks every
  future feature into "which session does this use?".
- **Heuristic-only** (never start an LSP for outline): rejected — regex
  extraction mis-handles C++ macros/templates/nested namespaces; it is a
  degraded tier, not a substitute for semantic symbols.

## Consequences

- Auto-created scopes are ordinary, visible scopes in Code scopes (born from
  Outline, editable, deletable). Deleting one means "don't recreate": the
  deletion is recorded (settings `codeIntelligenceDeclinedAutoScopes`, keyed by
  the deterministic scope id) and the Outline view then degrades to heuristic
  symbols plus an explicit enable button, never silent resurrection.
- SSH hosts never auto-create: setup there is heavy, so SSH shows the enable
  button instead (plus heuristic symbols meanwhile).
- Consent verification (#101): no first-install consent prompt exists for a
  scope with no consent — only *stale* consents surface in the editor banner
  and status-bar popover. So the Outline's creation flow grants consent itself
  right after upserting the scope, the same save-and-grant pattern the C++
  setup dialog and the managed-server switch use. Zero-config means no extra
  prompt; the user's off-switch remains deleting the scope (which is
  remembered).
- Monaco-internal TS worker symbols stay out of scope for now; if wanted
  later they arrive as just another Outline data provider.
