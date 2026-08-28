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
