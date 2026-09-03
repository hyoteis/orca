# Explorer absorbs the Code panel as the single file workbench

Turning the Code panel into a one-stop code workbench (open editors, file find, content search) would have duplicated the Explorer's surface, so we merged instead: the Code tab is removed from the activity bar (immediately, no degraded transition) and Explorer moves to first position, inheriting the reachability goal of #69. Scope members become a collapsible "Code scopes" section in Explorer with its own browsable member tree and an in-section add-member affordance; the find strip gains a pre-search range switch [◆ Scope | Worktree]. Out-of-tree and SSH members display as section rows with consent-gated browsing rather than being mapped into the remote tree. Open Editors, Names find, and Contents search stay where they are; the settings page remains the full scope editor and the status-bar popover the code-intelligence entry.

## Considered Options

- Coexist (Code panel adds its own open editors/find, Explorer untouched): cheapest, but duplicates two lists and two find entries forever.
- Code absorbs Explorer: one-stop taken literally, but retires the Explorer tab non-scope users rely on.
- Explorer absorbs Code, fused tree (scope marked only via the #73 in-scope diamond, no section): one tree, but out-of-tree/SSH members cannot render and the scope-centric browse loses its home.
- **Chosen**: Explorer absorbs Code with a dedicated scopes section. Decided in wayfinder tickets #75 (prototype) and #76 (topology); prototype preserved on branch `prototype/code-workbench-form-factor`.
