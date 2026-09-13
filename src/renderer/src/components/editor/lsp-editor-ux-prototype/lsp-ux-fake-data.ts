// PROTOTYPE (throwaway) — fake clangd data for the LSP editor UX prototype.
// Wayfinder ticket: https://github.com/hyoteis/orca/issues/179
// Branch: prototype/lsp-editor-ux. Nothing here talks to a real server.

export type LspUxServerPhase =
  | 'starting'
  | 'indexing'
  | 'ready'
  | 'crashed-restarting'
  | 'syntax-only'

export type LspUxHost = {
  /** Display name of the execution host owning the clangd process. */
  label: string
  kind: 'local' | 'ssh'
}

export const LOCAL_HOST: LspUxHost = { label: 'local', kind: 'local' }
export const SSH_HOST: LspUxHost = { label: 'ssh://llvm-devbox', kind: 'ssh' }

export const CLANGD_VERSION = 'clangd 19.1.2'

export type LspUxProgress = {
  /** $/progress percentage; null while the server only reports a stage. */
  percentage: number | null
  message: string
}

export type LspUxServerState = {
  phase: LspUxServerPhase
  host: LspUxHost
  progress: LspUxProgress | null
}

export const SERVER_STATES: Record<LspUxServerPhase, Omit<LspUxServerState, 'phase' | 'host'>> = {
  starting: { progress: null },
  indexing: {
    progress: { percentage: 42, message: '5,903 / 98,417 TUs' }
  },
  ready: { progress: null },
  'crashed-restarting': { progress: null },
  'syntax-only': { progress: null }
}

/** Sample C++ file with diagnostics planted at known lines (1-based). */
export const SAMPLE_CPP_PATH = 'llvm/lib/Support/RefTracker.cpp'

export const SAMPLE_CPP = `//===- RefTracker.cpp - Intrusive reference tracking -------*- C++ -*-===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
//
//===----------------------------------------------------------------------===//

#include "llvm/Support/RefTracker.h"
#include <cassert>

using namespace llvm;

namespace llvm {

RefCountedBase::~RefCountedBase() {
  assert(Refs > 0 && "reference count underflow");
  if (Refs == 0)
    RawPtr = nullptr;
}

void RefTracker::addEdge(RefHandle From, RefHandle To) {
  auto OldSize = Edges.size();
  Edges.push_back({From, To});
  retireGeneration(From.Generation);
}

size_t RefTracker::liveBytes() const {
  return LiveBytes;
}

void RefTracker::sweep() {
  visitAll([this](RefHandle H) { release(H); });
}

} // namespace llvm
`

/** Monaco marker shapes; severities: 8=Error 4=Warning 2=Info 1=Hint. */
export type FakeDiagnostic = {
  severity: 1 | 2 | 4 | 8
  message: string
  source: string
  startLine: number
  startColumn: number
  endColumn: number
}

export const FAKE_DIAGNOSTICS: FakeDiagnostic[] = [
  {
    severity: 8,
    message: "use of undeclared identifier 'RawPtr'",
    source: 'clang',
    startLine: 18,
    startColumn: 5,
    endColumn: 11
  },
  {
    severity: 4,
    message: "unused variable 'OldSize' [-Wunused-variable]",
    source: 'clang',
    startLine: 22,
    startColumn: 9,
    endColumn: 16
  },
  {
    severity: 2,
    message: "no matching member function for call to 'visitAll' (candidate requires 2 arguments)",
    source: 'clang',
    startLine: 32,
    startColumn: 3,
    endColumn: 11
  },
  {
    severity: 1,
    message: "clang-tidy: use '= default' to define this destructor [modernize-use-equals-default]",
    source: 'clang-tidy',
    startLine: 15,
    startColumn: 1,
    endColumn: 33
  }
]

export type HoverWord = {
  word: string
  /** clangd-style markdown: fenced signature + doc + index provenance. */
  markdown: string
}

export const FAKE_HOVERS: HoverWord[] = [
  {
    word: 'RefCountedBase',
    markdown: `#### class llvm::RefCountedBase
\`\`\`cpp
class RefCountedBase : public RefCountedBaseBase
\`\`\`
Reference-counted mixin for objects owned through \`IntrusiveRefCntPtr\`. Deleting an instance with outstanding references is undefined behavior.

---
*RefTracker.h:31* · indexed by ${CLANGD_VERSION} · 12 references`
  },
  {
    word: 'Edges',
    markdown: `#### llvm::RefTracker::Edges
\`\`\`cpp
SmallVector<RefEdge, 16> Edges
\`\`\`
Dense edge list; swept by generation at the end of each GC cycle.

---
*RefTracker.h:58* · indexed by ${CLANGD_VERSION}`
  },
  {
    word: 'retireGeneration',
    markdown: `#### llvm::RefTracker::retireGeneration
\`\`\`cpp
void retireGeneration(uint32_t Gen)
\`\`\`
Marks every handle in \`Gen\` as retired; actual release happens on the next \`sweep()\`.

---
*RefTracker.cpp:22* · indexed by ${CLANGD_VERSION}`
  },
  {
    word: 'visitAll',
    markdown: `#### llvm::RefTracker::visitAll
\`\`\`cpp
template <typename Visitor>
void visitAll(Visitor &&V, bool IncludeRetired = false) const
\`\`\`
Visits every live handle. Pass \`IncludeRetired = true\` during sweep.

---
*RefTracker.cpp:29* · indexed by ${CLANGD_VERSION}`
  }
]

export type FakeCompletion = {
  label: string
  /** Detail shown right of the label (signature / type). */
  detail: string
  kindName:
    | 'Method'
    | 'Field'
    | 'Function'
    | 'Class'
    | 'Struct'
    | 'Enum'
    | 'EnumMember'
    | 'Variable'
    | 'Constant'
    | 'Keyword'
    | 'Snippet'
    | 'Interface'
  documentation: string
  /** insertText with snippet syntax when kindName is Snippet. */
  insertText: string
  /** Triggered while typing after this prefix. */
  trigger: '.' | '::'
  sortBonus?: number
}

export const FAKE_COMPLETIONS: FakeCompletion[] = [
  {
    label: 'push_back(const T &Elt)',
    detail: 'void',
    kindName: 'Method',
    documentation: 'Appends an element, growing the SmallVector if needed. Amortized O(1).',
    insertText: 'push_back',
    trigger: '.'
  },
  {
    label: 'emplace_back(Args &&...args)',
    detail: 'T &',
    kindName: 'Method',
    documentation: 'Appends an element constructed in place; returns a reference to it.',
    insertText: 'emplace_back',
    trigger: '.'
  },
  {
    label: 'size()',
    detail: 'size_t',
    kindName: 'Method',
    documentation: 'Number of elements currently held.',
    insertText: 'size',
    trigger: '.'
  },
  {
    label: 'capacity()',
    detail: 'size_t',
    kindName: 'Method',
    documentation: 'Elements that fit before the next allocation.',
    insertText: 'capacity',
    trigger: '.'
  },
  {
    label: 'clear()',
    detail: 'void',
    kindName: 'Method',
    documentation: 'Destroys elements but keeps capacity.',
    insertText: 'clear',
    trigger: '.'
  },
  {
    label: 'Generation',
    detail: 'uint32_t',
    kindName: 'Field',
    documentation: 'GC generation this handle belongs to.',
    insertText: 'Generation',
    trigger: '.'
  },
  {
    label: 'size()',
    detail: 'size_t',
    kindName: 'Method',
    documentation: 'Number of live handles in the tracker.',
    insertText: 'size',
    trigger: '::',
    sortBonus: -1
  },
  {
    label: 'liveBytes()',
    detail: 'size_t',
    kindName: 'Method',
    documentation: 'Sum of live allocation sizes managed by the tracker.',
    insertText: 'liveBytes',
    trigger: '::'
  },
  {
    label: 'RefTracker',
    detail: 'class',
    kindName: 'Class',
    documentation: 'Central bookkeeping for intrusive reference tracking.',
    insertText: 'RefTracker',
    trigger: '::'
  },
  {
    label: 'RefHandle',
    detail: 'struct',
    kindName: 'Struct',
    documentation: 'Compact 8-byte handle: pool index + generation.',
    insertText: 'RefHandle',
    trigger: '::'
  },
  {
    label: 'RefKind',
    detail: 'enum',
    kindName: 'Enum',
    documentation: 'Static / Dynamic / External reference classes.',
    insertText: 'RefKind',
    trigger: '::'
  },
  {
    label: 'ExternalRef',
    detail: 'RefKind::External',
    kindName: 'EnumMember',
    documentation: 'Reference owned outside the pool (e.g. by the JIT).',
    insertText: 'ExternalRef',
    trigger: '::'
  },
  {
    label: 'LiveBytes',
    detail: 'const size_t',
    kindName: 'Constant',
    documentation: 'Bytes currently pinned by live references.',
    insertText: 'LiveBytes',
    trigger: '::'
  },
  {
    label: 'constexpr',
    detail: '',
    kindName: 'Keyword',
    documentation: 'C++ keyword.',
    insertText: 'constexpr',
    trigger: '::',
    sortBonus: -2
  },
  {
    label: 'refFor(const void *Ptr)',
    detail: 'RefHandle refFor(Ptr)',
    kindName: 'Function',
    documentation: 'Returns the handle owning Ptr; asserts it is tracked.',
    insertText: 'refFor',
    trigger: '::'
  },
  {
    label: 'Visitor',
    detail: 'template <typename Visitor>',
    kindName: 'Variable',
    documentation: 'Callable invoked as bool(RefHandle).',
    insertText: 'Visitor',
    trigger: '::'
  },
  {
    label: 'RefCounted',
    detail: 'interface',
    kindName: 'Interface',
    documentation: 'Duck-typed protocol: retain() / release().',
    insertText: 'RefCounted',
    trigger: '::'
  },
  {
    label: 'sweep_all',
    detail: 'snippet',
    kindName: 'Snippet',
    documentation: 'for (auto It = Retired.begin(); It != Retired.end(); ++It) { sweep(*It); }',
    insertText: 'for (auto It = ${1:Retired}.begin(), E = ${1:Retired}.end(); It != E; ++It) {\n\t$0\n}',
    trigger: '::',
    sortBonus: 1
  }
]


export const DIAGNOSTIC_TOTALS = {
  errors: FAKE_DIAGNOSTICS.filter((d) => d.severity === 8).length,
  warnings: FAKE_DIAGNOSTICS.filter((d) => d.severity === 4).length,
  infos: FAKE_DIAGNOSTICS.filter((d) => d.severity === 2).length,
  hints: FAKE_DIAGNOSTICS.filter((d) => d.severity === 1).length
}
