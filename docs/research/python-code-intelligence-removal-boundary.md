# Python code-intelligence removal boundary — inventory

**Research date:** 2026-09-07
**Research ticket:** [#120 Map the Python code-intelligence removal boundary](https://github.com/hyoteis/orca/issues/120) (parent map: #119)

Scope: which persisted types, IPC contracts, language-server sessions, renderer integrations, tests, localization entries, migrations, and shared abstractions belong to Python Code Intelligence (introduced across #30 and related LSP work, entry commit `46b06b701`), and which Python editing/notebook surfaces must remain untouched. Primary source is the current working tree at `f667fd977a`. Wire-safety verdicts follow [`docs/reference/remote-wire-compatibility.md`](../reference/remote-wire-compatibility.md) (optional field safe / new opcode or method must negotiate / published-content changes are stealth wire changes).

## Verdict summary

| Surface | Disposition |
|---|---|
| Python renderer modules (session, navigation, Monaco features) | **Delete** (3 files + 3 test files) |
| Python branch in shared scope/language unions | **Narrow** (`CodeIntelligenceLanguage`, `LanguageServerKind`, `ManagedLanguageServerToolId`) |
| Manifest entries: pyright, basedpyright, private `node` runtime | **Delete** — node runtime exists only for Python servers |
| IPC / runtime RPC channels | **Keep contracts, prune payloads** — channels are language-agnostic; python kinds disappear from them |
| Configure Code dialog Python side, Outline/Symbol-search python branches, status labels | **Prune python branches** in shared components |
| Managed install pipeline, session managers, client registry, semantic-edit/workspace-edit stacks | **Keep** — shared with clangd |
| Persisted settings (`codeIntelligenceScopes`, `codeIntelligenceDeclinedAutoScopes`) | **Migrate**: drop python scopes, prune python declined ids; C++ members → BASIC per #119 contract |
| Ordinary Python editing, Monaco python syntax highlighting, notebook execution | **Untouched** |

## 1. Persisted types, schemas, and settings stores

- **`GlobalSettings.codeIntelligenceScopes?: CodeIntelligenceScope[]`** — [`src/shared/types.ts:2811`](../../src/shared/types.ts). The only persisted scope list; python scopes are members with `language: 'python'`. Persisted through the settings store (`src/main/ipc/settings.ts`) into the persistence file owned by [`src/main/persistence.ts`](../../src/main/persistence.ts).
- **`GlobalSettings.codeIntelligenceDeclinedAutoScopes?: string[]`** — [`src/shared/types.ts:2814`](../../src/shared/types.ts). Holds Outline auto-scope ids; python ids have the `…:python` suffix produced by `getCodeIntelligenceScopeId` ([`src/shared/code-intelligence-scope.ts:25-31`](../../src/shared/code-intelligence-scope.ts)) — must be pruned on migration.
- **`CodeIntelligenceLanguage = 'python' | 'cpp'`** and the python branches of the scope contract — [`src/shared/code-intelligence-scope.ts:11-16`](../../src/shared/code-intelligence-scope.ts) (`languageServerKindForScope` → `basedpyright`), and the python-only member rule at [`:162-163`](../../src/shared/code-intelligence-scope.ts) (`normalizeCodeIntelligenceScope` rejects absolute members for python).
- **Consent + fingerprint machinery** — `CodeIntelligenceScopeConsent`, `codeIntelligenceConfigurationSnapshot`, `canonicalConfigurationJson` ([`src/shared/code-intelligence-scope.ts:47-58, 226-258`](../../src/shared/code-intelligence-scope.ts)). Shared with C++; python consents ride inside python scopes and disappear with them.
- **Renderer localStorage cache** — `orca.codeIntelligence.directoryScan.v1` ([`src/renderer/src/lib/language-server/code-intelligence-directory-scan-cache.ts:12-14`](../../src/renderer/src/lib/language-server/code-intelligence-directory-scan-cache.ts)). Shared dialog scan cache (cpp + python dialog paths); key itself stays, stale python entries self-expire (10-minute TTL) — no forced migration needed.
- **Host-side disk state (main-owned)**:
  - `<userData>/code-intelligence/cpp/...` — clangd-only scope dirs; untouched.
  - `<userData>/code-intelligence/managed/` managed roots — per-tool dirs for `basedpyright`, `pyright`, and the private `node` runtime, plus `ManagedLanguageServerActivationRecord`s ([`src/main/language-server/managed-language-server-install-root.ts`](../../src/main/language-server/managed-language-server-install-root.ts)). Python tool dirs become orphaned disk data after removal; GC keys off the manifest, so deleting the entries strands old dirs (see §7).
  - SSH-host managed roots — [`src/main/language-server/code-intelligence-ssh-managed-install-root.ts`](../../src/main/language-server/code-intelligence-ssh-managed-install-root.ts) and `-state.ts`; same stranding question on remote hosts.

## 2. IPC / RPC contracts carrying Python setup/config

Desktop IPC (registered in [`src/main/ipc/code-intelligence.ts:114-184`](../../src/main/ipc/code-intelligence.ts), wiring at [`src/main/ipc/register-core-handlers.ts:224-225`](../../src/main/ipc/register-core-handlers.ts); preload exposure at [`src/preload/index.ts:496-516`](../../src/preload/index.ts), typed at [`src/preload/api-types.ts:1137-1163`](../../src/preload/api-types.ts)):

- `codeIntelligence:setupCpp` — C++-only, unaffected.
- `codeIntelligence:upsertScope` / `removeScope` / `grantConsent` / `authorizeSession` + `codeIntelligence:scopeChanged` broadcast — language-agnostic contracts that currently carry python scopes. After removal they only ever carry `language: 'cpp'`; channels stay.
- Managed install channels `codeIntelligence:managedInstallState`, `installManagedLanguageServer`, `cancelManagedLanguageServerInstall`, `rollbackManagedLanguageServer`, `managedInstallEvent` ([`src/main/ipc/code-intelligence-managed-install.ts`](../../src/main/ipc/code-intelligence-managed-install.ts)) — tool-parameterized; `tool: 'basedpyright' | 'pyright'` disappears from legal payloads.
- Session channels `languageServers:open` / `write` / `close` / `languageServers:event` ([`src/main/ipc/language-server-sessions.ts`](../../src/main/ipc/language-server-sessions.ts), preload [`src/preload/language-server-sessions.ts`](../../src/preload/language-server-sessions.ts)) — generic; python kinds disappear from `LanguageServerLaunchRequest.kind`.

Runtime RPC (paired remote hosts — wire-compat gated):

- `languageServer.session` subscribe method ([`src/renderer/src/runtime/runtime-language-server-session.ts`](../../src/renderer/src/runtime/runtime-language-server-session.ts) client; [`src/main/runtime/rpc/methods/language-server.ts`](../../src/main/runtime/rpc/methods/language-server.ts) host) — params carry `kind: LanguageServerKind`.
- `languageServer.managedInstall`, `languageServer.managedInstallState`, `languageServer.managedRollback` (client [`src/renderer/src/components/status-bar/runtime-managed-install-rpc.ts:76-107`](../../src/renderer/src/components/status-bar/runtime-managed-install-rpc.ts)).
- **Wire note:** `LANGUAGE_SERVER_KINDS` ([`src/shared/language-server-session.ts:7`](../../src/shared/language-server-session.ts)) is the zod literal tuple hosts validate against. Narrowing the union on a new host breaks an *old client that still holds python scopes* opening a session there (zod strips/拒绝 the kind). Desktop client+main always ship together and the settings migration removes python scopes in main, so the exposure is the mixed-version remote pair. Lazy-safe option: keep the wire union accepting python kinds on the host while never resolving them, or accept the break — decide against the wire-compat doc's rule 3.

## 3. Language-server sessions and lifecycle (Python)

- **`PythonCodeIntelligenceSession`** — [`src/renderer/src/lib/language-server/python-code-intelligence-session.ts`](../../src/renderer/src/lib/language-server/python-code-intelligence-session.ts). Singleton (`getPythonCodeIntelligenceSession`); one basedpyright client per python scope through the shared `LanguageServerClientRegistry`; single-flight `opening` map (the #33 single-flight fix), diagnostics push (`subscribePythonDiagnostics`), and the `workspaceApplyEditHandler` interception (#37). **Delete whole file.**
- **`python-definition-navigation.ts`** — definition/references/documentSymbol/workspaceSymbol requests with the labelled text-search fallback (`getPythonSessionState` quality `'semantic' | 'text-search'`); re-exports `PYTHON_LANGUAGES`. **Delete whole file.**
- **Spawn defaults** — `resolveDefaultLocalLanguageServerCommand` carries `basedpyright-langserver --stdio` and `pyright-langserver --stdio` PATH fallbacks ([`src/main/language-server/local-language-server-session-manager.ts:24-34`](../../src/main/language-server/local-language-server-session-manager.ts)). Prune both entries; the manager itself is shared with clangd.
- **SSH sessions** — [`src/main/ssh/ssh-language-server-session-manager.ts`](../../src/main/ssh/ssh-language-server-session-manager.ts) is generic; python launches arrive only via manifest-resolved commands (`runtimeEntryId` → node binary). No python literals in it.
- **Managed acquisition** — [`src/main/language-server/managed-language-server-acquisition.ts:33-34`](../../src/main/language-server/managed-language-server-acquisition.ts) resolves `entry.runtimeEntryId` to the private node runtime; `managedRuntimeRoot` exists solely for Python servers. With python gone, the `node` tool, `runtimeEntryId`, and runtime-root resolution all collapse.
- **Nightly budget fixture** — `tests/nightly/code-intelligence/python-large-fixture.budget.test.ts` + `generatePythonMonorepoFixture` in [`tests/nightly/code-intelligence/large-fixture-generators.ts:152-169`](../../../tests/nightly/code-intelligence/large-fixture-generators.ts).

## 4. Renderer integrations

- **Configure Code dialog** — [`src/renderer/src/components/sidebar/CodeIntelligenceCppSetupDialog.tsx`](../../src/renderer/src/components/sidebar/CodeIntelligenceCppSetupDialog.tsx): `savePythonScope` (~:176-204), the `language === 'python'` description branch (~:229-231), and the C++/Python `SettingsSegmentedControl` (~:248-256). Selection model python branch — [`src/renderer/src/components/sidebar/code-intelligence-setup-scope-selection.ts:45-138`](../../src/renderer/src/components/sidebar/code-intelligence-setup-scope-selection.ts) (`pythonScopeId`, relative-only member picks).
- **Outline** — [`src/renderer/src/components/right-sidebar/use-outline-symbols.ts:13,138`](../../src/renderer/src/components/right-sidebar/use-outline-symbols.ts) (`getPythonDocumentSymbols`, family label); [`outline-model.ts:19-26`](../../src/renderer/src/components/right-sidebar/outline-model.ts) (`OUTLINE_SUPPORTED_LANGUAGES` includes `'python'`, `outlineLanguageFamily` returns `'python'`, `resolveOutlineAutoScope` language-parameterized); [`outline-heuristics.ts:191`](../../src/renderer/src/components/right-sidebar/outline-heuristics.ts) (`pyLine` branch).
- **Symbol search (SearchPanel / Code panel Symbols mode)** — [`src/renderer/src/components/right-sidebar/use-symbol-search.ts:3,60-68`](../../src/renderer/src/components/right-sidebar/use-symbol-search.ts) fans out `searchPythonWorkspaceSymbols` alongside cpp; consumer [`SearchPanel.tsx`](../../src/renderer/src/components/right-sidebar/SearchPanel.tsx).
- **Monaco providers** — [`src/renderer/src/lib/language-server/python-monaco-language-features.ts`](../../src/renderer/src/lib/language-server/python-monaco-language-features.ts): `registerPythonMonacoDocument` registers hover/documentSymbol/reference providers for `'python'` (:155-183) and diagnostic markers under owner `'orca-python'` (:243-260). Wired in [`MonacoEditor.tsx:70,410-411,589`](../../src/renderer/src/components/editor/MonacoEditor.tsx) gated on a python scope existing (`codeIntelligenceRequestAt`). **Delete module + wiring.**
- **Status bar** — [`CodeIntelligenceStatusSegment.tsx:326`](../../src/renderer/src/components/status-bar/CodeIntelligenceStatusSegment.tsx) renders the `'Python'` scope label; [`ManagedLanguageServerStatusSection.tsx:20-27`](../../src/renderer/src/components/status-bar/ManagedLanguageServerStatusSection.tsx) derives tool rows from scopes (python rows vanish with the scopes).
- **Semantic editing** — [`semantic-editing-requests.ts`](../../src/renderer/src/lib/language-server/semantic-editing-requests.ts) is the shared factory (`createSemanticEditingRequests(getPythonCodeIntelligenceSession)` vs the cpp instance); the python instantiation, the python fixtures in `semantic-edit-landing.ts`, and the whole downstream workspace-edit stack stay (cpp keeps using them).

## 5. Tests

Delete outright (python-only):

1. [`src/renderer/src/lib/language-server/python-definition-navigation.test.ts`](../../src/renderer/src/lib/language-server/python-definition-navigation.test.ts)
2. [`src/renderer/src/lib/language-server/python-monaco-language-features.test.ts`](../../src/renderer/src/lib/language-server/python-monaco-language-features.test.ts)
3. [`tests/nightly/code-intelligence/python-large-fixture.budget.test.ts`](../../../tests/nightly/code-intelligence/python-large-fixture.budget.test.ts) + the python generator in `large-fixture-generators.ts`

Prune python cases/fixtures inside shared test files (32): `code-intelligence-workspace`, `code-intelligence-session-single-flight`, `code-intelligence-scope-member-edit`, `semantic-editing-requests`, `semantic-monaco-providers`, `lsp-monaco-conversions`, `language-server-document-registry`, `language-server-document-sync-controller`, `semantic-workspace-edit-drawer-store`, `semantic-workspace-edit-flow`, `workspace-edit-{path-authorization,plan,store-projection,transaction,undo-stack}`, `cpp-definition-navigation-session-reuse` (all under `src/renderer/src/lib/language-server/`); `OutlinePanel.test.tsx`, `use-symbol-search.test.tsx`, `SymbolSearchResults.test.tsx`, `useFileSearchPanel.test.tsx`, `outline-model.test.ts`, `outline-heuristics.test.ts`, `code-panel-member-tree.test.ts`, `CodeScopesSection.test.tsx`, `CodeIntelligenceStatusSegment.test.tsx`, `ManagedLanguageServerStatusSection.test.tsx`, `code-intelligence-setup-scope-selection.test.ts`, `SemanticWorkspaceEditDrawer.test.tsx`, `MonacoEditor.font-family.test.tsx` (its `python-monaco` mock — the known MonacoEditor test-registry constraint), `code-intelligence.test.ts` and `language-server-sessions.test.ts` (src/main/ipc), `clangd-compile-commands-dir.test.ts:64` ("skips validation for python launches"), `src/shared/code-intelligence-scope.test.ts`, `src/shared/managed-language-server-manifest-data.test.ts`.

**Unrelated python mentions in tests — keep**: `notebook.test.ts`, `ipynb-parse.test.ts`, `useIpcEvents.test.ts` (process recognition of `python -m http.server`), `register-nim.test.ts` (`source.python` grammar probe), `ssh-relay-*` (node-gyp `python3` toolchain), pty/local-pty/windows-environment-path/transcript-decoders/agent-followup-delivery/agent-process-recognition/pi-agent-kind/setup-script-shebang/test-code-path/commit-failure-summary/file-search-range/native-chat-composer-state.

## 6. Localization entries

All five locales (`en`, `zh`, `ja`, `ko`, `es` under `src/renderer/src/i18n/locales/`):

- **Delete** `settings.codeIntelligence.pythonSetupDescription` and `settings.codeIntelligence.pythonScopeSaved` (10 entries total across locales).
- **Copy-edit** (mention Python but cover cpp too): `auto.components.right.sidebar.OutlinePanel.2b8019ac88` ("Supports Python and C++ files") and `auto.components.rightSidebar.CodePanel.notProjectCopy` ("…configure C++ / Python indexing here"). i18n hash keys depend on file paths — rebuild locale blocks with node, not inline splices.
- **Keep**: `auto.components.editor.IpynbViewer.10ed04a685` (notebook trust notice) and `auto.components.editor.RichMarkdownCodeBlock.2391f9cda9` ("Python" code-block label).

## 7. Migrations / versioned persisted state

- **Precedent**: `persistence.ts` applies lazy `migrateX(settings)` functions at load (e.g. `migrateTerminalScrollbackRows`, [`src/main/persistence.ts:3149+`](../../src/main/persistence.ts)); `CodeIntelligenceScopeStore.list()` ([`src/main/language-server/code-intelligence-scope-store.ts:100-115`](../../src/main/language-server/code-intelligence-scope-store.ts)) already does a lazy no-compat member-shape migration.
- **Needed step** (per #119 contract): on load, drop scopes with `language: 'python'` from `codeIntelligenceScopes`, prune `…:python` ids from `codeIntelligenceDeclinedAutoScopes`, and migrate surviving C++ members to BASIC mode. The mode field is `CodeIntelligenceConfigurationMode` / `scope.setupStatus.mode` ([`src/shared/code-intelligence-scope.ts:56-65`](../../src/shared/code-intelligence-scope.ts)); the per-member BASIC degradation precedent is commit `6401cf3f73`. **Fog:** the map's "C++ members migrate to BASIC mode" phrasing is not yet pinned to field-level semantics (whole-scope `setupStatus.mode = 'basic'` vs per-member state) — the implementing ticket must decide; no current code writes a cpp→basic bulk migration.
- **Disk orphans**: deleting `pythonServerEntries`/`nodeEntry` from the manifest strands already-installed `basedpyright`/`pyright`/`node` dirs under the managed roots (local and SSH) — the GC protects only manifest-resolvable versions. A one-time sweep of python tool roots (mirroring `sweepOrphanCppScopeDirectories` in [`code-intelligence-setup-cache.ts`](../../src/main/language-server/code-intelligence-setup-cache.ts)) is optional cleanup, not correctness.

## 8. Shared abstractions (keep / split / narrow)

**Keep as-is (clangd keeps using them):** `LanguageServerSessionsApi` and session/lifecycle plumbing ([`src/shared/language-server-session.ts`](../../src/shared/language-server-session.ts) minus python kinds); `LocalLanguageServerSessionManager`, `SshLanguageServerSessionManager`, `language-server-session-io-policy`; renderer `LanguageServerClientRegistry`, `language-server-document-registry` / `-sync-controller` / `-uri`, `language-server-session-lifecycle` / `-connection`; `semantic-monaco-{providers,stack,documents}`, `lsp-monaco-conversions`, `document-symbol-monaco-mapping` ("Shared by the Python and C++ Monaco document-symbol providers", :21); `definition-link-affordance`, `navigation-request-cache` (both extracted *for* python in `46b06b701`, now cpp's too); `code-intelligence-workspace` (`findCodeIntelligenceScope` language parameter narrows to cpp-only), `code-intelligence-scope-membership`, `code-intelligence-scope-member-edit`; the entire workspace-edit/semantic-editing stack; `CodeIntelligenceScopeStore` + consent machinery; the managed install pipeline (`managed-language-server-{installer,acquisition,archive,extraction,install-root}`) and its SSH/relay adapters; the Configure Code dialog's directory discovery (`use-code-intelligence-directory-discovery`) and scan cache.

**Narrow unions:** `CodeIntelligenceLanguage` `'python' | 'cpp'` → `'cpp'` (collapses `languageServerKindForScope`); `LanguageServerKind` drop `'basedpyright' | 'pyright'` (wire caveat in §2); `ManagedLanguageServerToolId` drop `'basedpyright' | 'pyright' | 'node'` — `'node'` exists only for Python servers ([`src/shared/managed-language-server.ts:5`](../../src/shared/managed-language-server.ts), `runtimeEntryId` at :52).

**Delete python-only:** `pythonServerEntries` + `nodeArchives`/`nodeEntry` in [`src/shared/managed-language-server-manifest-data.ts:42-110,171-237`](../../src/shared/managed-language-server-manifest-data.ts) (manifest ids are stable-forever per its header comment — deleting entries is fine, never renumber); the three renderer python modules (§3-4).

**Docs to update:** [`src/shared/CONTEXT.md`](../../src/shared/CONTEXT.md) (python wording at :7,:16,:38,:73), [`docs/spec/code-intelligence-cpp-multi-folder.md`](../spec/code-intelligence-cpp-multi-folder.md), [`docs/adr/0003-outline-symbol-sources.md`](../adr/0003-outline-symbol-sources.md).

**Fog (cannot yet name precisely):** (a) the cpp→BASIC migration semantics (§7); (b) whether the wire union keeps tolerating python kinds for mixed-version remote pairs or breaks them (§2); (c) whether `pyright` (unused by any UI — scopes only ever resolve `basedpyright`) has any consumer at all beyond manifest/tests — none found in `src/`.

## 9. Must remain untouched

- **Ordinary Python editing** — MonacoEditor basic editing for `.py`; `language-detect.ts:44` maps `.py` → `'python'` ([`src/renderer/src/lib/language-detect.ts`](../../src/renderer/src/lib/language-detect.ts)).
- **Syntax highlighting** — Monaco basic-languages python grammar; module declaration at [`src/renderer/src/env.d.ts:9`](../../src/renderer/src/env.d.ts). Nothing in the removal touches monaco language registration.
- **Notebook execution** — `notebook:runPythonCell` IPC ([`src/preload/index.ts:3147-3153`](../../src/preload/index.ts)), [`src/main/ipc/notebook.ts`](../../src/main/ipc/notebook.ts), [`IpynbViewer.tsx`](../../src/renderer/src/components/editor/IpynbViewer.tsx) + `ipynb-parse.ts` + `ipynb-code-cell-lines.ts` + editor-store slices. Verified: the notebook viewer imports nothing from `lib/language-server` — it is fully isolated from code intelligence.
- **Incidental python references elsewhere** — SSH relay node-gyp toolchain probes (`python3` in [`ssh-relay-build-toolchain.ts:18-38`](../../src/main/ssh/ssh-relay-build-toolchain.ts)), agent process recognition of `python` processes, pty/terminal surfaces, the RichMarkdown "Python" label.
