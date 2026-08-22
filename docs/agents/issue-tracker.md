# Issue tracker: GitHub

Issues and specs for this repo live in GitHub repository `hyoteis/orca`. Use the `gh` CLI with `--repo hyoteis/orca` for all operations; do not infer the repository from `origin`, which points at a different fork.

## Conventions

- **Create an issue**: `gh issue create --repo hyoteis/orca --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --repo hyoteis/orca --comments`
- **List issues**: `gh issue list --repo hyoteis/orca --state open --json number,title,body,labels,comments`
- **Comment**: `gh issue comment <number> --repo hyoteis/orca --body "..."`
- **Apply/remove labels**: `gh issue edit <number> --repo hyoteis/orca --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo hyoteis/orca --comment "..."`

Use heredocs or body files for multiline content. Batch GitHub API reads where practical.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. When a bare reference is ambiguous, resolve it explicitly with `gh pr view` and then `gh issue view`, both using `--repo hyoteis/orca`.

## Skill operations

- When a skill says **publish to the issue tracker**, create an issue in `hyoteis/orca`.
- When a skill says **fetch the relevant ticket**, run `gh issue view <number> --repo hyoteis/orca --comments`.
- Preserve GitHub and GitLab provider-neutral terminology in implementation code even though this workflow uses GitHub.

## Wayfinding operations

The map is a GitHub issue labelled `wayfinder:map`; child decision or implementation tickets are linked as sub-issues.

- **Map**: create with `gh issue create --repo hyoteis/orca --label wayfinder:map`.
- **Child ticket**: link it through the GitHub sub-issues API. If unavailable, add it to the map task list and put `Part of #<map>` at the top of its body.
- **Child labels**: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub native issue dependencies via `repos/hyoteis/orca/issues/<child>/dependencies/blocked_by`, passing the blocker?s numeric database ID. If unavailable, use a `Blocked by: #<n>` line.
- **Frontier**: choose the first open, unassigned child in map order whose blockers are all closed.
- **Claim**: `gh issue edit <number> --repo hyoteis/orca --add-assignee @me`.
- **Resolve**: comment with the result, close the child, then add its decision/context pointer to the map.
