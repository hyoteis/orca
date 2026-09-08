# C++-Only Code Configuration — Implementation & Verification Contract

Status: **Locked.** Produced by wayfinder map [#119](https://github.com/hyoteis/orca/issues/119), ticket [#127](https://github.com/hyoteis/orca/issues/127), from decisions [#120](https://github.com/hyoteis/orca/issues/120)–[#126](https://github.com/hyoteis/orca/issues/126). Execution works these steps in order; each step lands green independently.

Research inputs (merged in Step 0):

- `docs/research/host-config-path-refresh-audit.md` (#122)
- `docs/research/python-code-intelligence-removal-boundary.md` (#120)
- `docs/research/clangd-mapped-database-topology.md` (#121)
- Prototype: `prototype/cpp-configure-code-workflow/index.html` (winning shape dc25adf928)

## 1. Standing product contract

- Remove Python code-intelligence/LSP configuration and runtime support; keep ordinary Python editing, syntax highlighting, notebooks.
- A code folder selects exactly one mode: one supplied `compile_commands.json` or BASIC (shared include/define/C++-standard settings). CMake/GN automatic configuration is removed.
- Code folders live inside the workspace. A compile database may live anywhere on the same execution host; one database may serve multiple non-overlapping folders; overlapping configured folders are rejected.
- Validation: existence, JSON shape, ≥1 in-folder command (initial only). Incomplete source coverage warns, never blocks (clangd may infer).
- Auto-refresh changed databases + manual reload. Later deletion/corruption keeps last-valid mapping cache, marks it degraded, other mappings unaffected.
- All current C++ capabilities continue across mappings (browsing, semantic highlighting, hover, definition/reference navigation, Outline, workspace-symbol search, formatting). External dependencies aid analysis but stay hidden and unopenable.
- Mapping structure changes reauthorize; database content changes never do.
- Migrate existing C++ members to BASIC, drop saved Python scopes, never modify supplied databases, aggregate data only in Orca-managed cache.
- Preserve local Win/macOS/Linux, SSH, git-worktree, folder-workspace support. No new execution-host categories, no new editor capabilities.

## 2. Rollout steps

Each step: seams, deletions, checks, acceptance. Steps 1→5 are PR-sized; nothing ships to users between steps that breaks a previous step.

### Step 0 — Docs landfall

Cherry-pick the two research docs (from `research/python-code-intelligence-removal` @ 8b13d5fc3b and `research/clangd-mapped-database-topology` @ 3fb0e735ec) into main alongside the existing audit; this contract lands in the same PR.

**Acceptance:** all three research docs reachable from main; links in this contract resolve.

### Step 1 — Persisted model + migration (addition first, #123)

Seams:

- Member gains optional host-absolute `compileDatabase`; absent field = BASIC — legacy members migrate with zero rewrite.
- `basicOptions` persisted per scope; joins the consent payload, empty-means-key-omitted.
- Overlap rejection: a mapped folder intersecting any folder is rejected; BASIC∩BASIC nesting keeps longest-match.
- Wire `LANGUAGE_SERVER_KINDS` keeps tolerating python kinds with explicit host rejection; revisions unchanged.
- Lazy migration runs on first read: drops persisted python scopes, blanks legacy `setupStatus`, preserves cpp consents, arms the one-time upgrade notice flag.

Checks / acceptance:

- Zero-rewrite migration test (legacy member bytes unchanged without explicit edit).
- Golden setup-fingerprint digest updated **deliberately** (payload changed), with digest-sensitivity assertion (precedent: cmakeDefines golden update).
- Overlap-rejection and longest-match unit tests.
- Zero new red vs main baseline.

### Step 2 — Python removal (#120)

Deletion boundary: the explicit file/function list in `docs/research/python-code-intelligence-removal-boundary.md` is the checklist — three renderer modules, the `'python'` member of shared unions, pyright/basedpyright + private-`node` manifest entries. Stays: notebooks, Monaco python highlighting, everything shared with clangd (session managers, managed-install, scope/consent store, IPC/RPC channels).

Checks / acceptance:

- Checklist ticked per file in the PR description; code review confirms; **no CI grep** (brittle).
- Old-runtime tolerance unit tests from Step 1 (python kinds → host rejection) still green.
- Notebook + highlighting regression suites green. Zero new red.

### Step 3 — Aggregate pipeline & session (#121 T1 + #124)

Seams:

- One clangd per (executionHost, workspace) cpp scope over the Orca-merged aggregate CDB in Orca cache with `--compile-commands-dir` (FixedDir); launch unchanged from today.
- Setup pipeline collapses into the aggregate builder: validate → normalize → BASIC synth → precedence merge → atomic write + manifest.
- Content re-merges never restart sessions (`setupGeneratedAt` leaves the launch-diff; restart only on real launch-config change).
- Duplicate TUs: `scope.members`-order first-wins to one canonical entry.
- Entry normalization: `arguments`/`command` verbatim, unknown keys dropped, host-absolute native `file`, byte-stable sort.
- Per-mapping `mappings/<id>.json` last-valid entries → independent degradation; existing sweeps cover cleanup.
- Refresh: local `fs:changed` / SSH provider watch + session-open drift re-check; debounced single-flight re-merge per scope; no polling; **no new runtime RPC**.
- Paired-runtime hosts have no C++ setup — out of path entirely.

Checks / acceptance:

- Merge/normalize unit tests incl. duplicate-TU first-wins, byte-stability (golden aggregate).
- Re-merge-without-restart session test; restart-only-on-launch-change test.
- Degradation independence test (one mapping unreadable → others intact).
- SSH watch + drift re-check unit tests (mocked provider).

### Step 4 — Authorization & status semantics (#126)

Seams:

- Consent payload carries per-member `compileDatabase` + `basicOptions` (structure only; content stats live in the setup fingerprint).
- Workspace-folder evolution auto-syncs members inheriting the workspace mode; rides the existing stale-consent banner. Mode/database change reauthorizes on save.
- Auto re-merge silent on success; one toast only on →degraded; silent recovery.
- Later validation checks readability only: unreadable → degraded with last-valid; readable-but-flawed (incl. zero coverage) → warning; auto-heal via watcher.
- Duplicate-TU conflicts surface as one dialog status line.
- Mapping health reaches the renderer as an ephemeral field on the existing scope-snapshot push (no new channel, never persisted).
- Status × surface: degraded joins the editor banner (dismissible, auto-clears); warnings never do.
- One-time dismissible Code-panel upgrade notice covering BASIC migration + python removal.

Checks / acceptance:

- Status×surface matrix tests (banner visibility per state).
- Consent evolution + reauthorization unit tests.
- Upgrade-notice once-only + dismiss persistence test.

### Step 5 — UI + CMake/GN deletion (#125)

Seams:

- Workspace-level Configure Code dialog per prototype: one row, mode segmented control (supplied CDB | BASIC) on the row head.
- CDB mode: host-absolute path + Browse… (SSH browses the remote host) + status (valid / degraded-with-last-valid / partial coverage) + revalidate-and-reload.
- BASIC options inline in the row (per-scope). UI exposes workspace-level only; the per-folder contract stays in the persisted model as backend guardrail.
- CMake/GN UI entries die with the old dialog; the underlying cmake/gn generator code (`code-intelligence-cpp-setup-generation.ts` and kin, incl. `cmakeDefines`) is deleted in the same step.
- Locale keys added in **en + zh** together (lesson: gear aria-label zh gap).

Checks / acceptance — CDP (`$electron`, Windows dev only):

1. Local valid CDB configured → symbols + semantic colors green in Code panel.
2. DB file deleted → degraded banner, last-valid keeps working, auto-recovery on restore.
3. SSH remote browse + CDB selection end-to-end.

Component tests (no CDP): upgrade notice render, BASIC inline options save, partial-coverage warning, mode-switch reauthorization.

Deletion acceptance: checklist ticked (generator files, cmakeDefines plumbing, old dialog components), code review, zero new red.

## 3. Test matrix

| Layer | Covers |
|---|---|
| Unit | migration, overlap, merge/normalize golden, degradation isolation, wire tolerance (old host / old client), status matrix |
| Integration | aggregate pipeline → clangd session lifecycle (merge no-restart), refresh/debounce single-flight, SSH watch |
| CDP UI | scenarios 1–3 above (Windows only) |
| Nightly mixed-version CI | one representative SSH scenario: new client + old host (graceful absence of new fields/RPC) |

macOS/Linux: covered by CI unit matrix (posix/win32 path normalization, atomic write), no manual pass.

## 4. Remote wire

- New/changed fields are optional → safe per `docs/reference/remote-wire-compatibility.md`.
- No new stream opcodes; no new runtime RPC (Step 3).
- Old host + new client: degrade (absent fields → BASIC; absent capability → existing fallback paths).
- New host + old client: old client ignores unknown optional fields; tolerance unit test required.

## 5. Performance guardrails

- Regression smoke: 10k-entry CDB merge completes, aggregate write is atomic, renderer never blocked. No numeric SLOs until measurement demands them.
- Reuse existing guardrails: readDirTree 100k-entry cap, dialog scan cache (512KB / 8 workspaces / 10min TTL).
- Debounce + single-flight per scope (Step 3) is the pacing contract.

## 6. Global acceptance

- Zero new failures vs the recorded main baseline (~181–183 known reds: IPv4 loopback, files.rename, bundled-gn WIP).
- All new tests green; deletion checklists ticked; no CI grep assertions.
- Golden digests updated deliberately where payloads changed.

## 7. Known user-workflow change (accepted)

OHOS cross-compile (cmakeDefines → Orca-run cmake) is removed with Step 5. New workflow: generate `compile_commands.json` outside Orca (e.g. DevEco cmake/ninja), attach it as the supplied CDB; Step 3 refresh auto-reloads on regeneration.
