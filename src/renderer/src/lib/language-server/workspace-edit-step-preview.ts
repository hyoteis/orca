import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'

export type WorkspaceEditDiffRow = { kind: 'context' | 'add' | 'remove'; text: string }

export type WorkspaceEditStepPreview = {
  type: WorkspaceEditPlannedStep['type']
  /** Display path relative to the workspace root when inside it. */
  path: string
  /** Rename destination (rename only). */
  nextPath?: string
  addLines: number
  removeLines: number
  diff: readonly WorkspaceEditDiffRow[] | null
  /** create.overwrite — an existing file gets truncated. */
  overwrite?: boolean
}

// ponytail: O(n·m) LCS capped at 2000×2000 lines; larger previews degrade to
// whole-file add/remove — swap for Myers diff if giant files ever land here.
const MAX_DIFF_LINES = 2000
const CONTEXT_RUN_LIMIT = 10

export function diffLines(before: string, after: string): WorkspaceEditDiffRow[] {
  const rows = lcsRows(splitLines(before), splitLines(after))
  return collapseContextRuns(rows)
}

export function buildWorkspaceEditStepPreviews(args: {
  steps: readonly WorkspaceEditPlannedStep[]
  workspaceRoot: string
}): WorkspaceEditStepPreview[] {
  return args.steps.map((step): WorkspaceEditStepPreview => {
    if (step.type === 'rename') {
      return {
        type: 'rename',
        path: displayWorkspaceEditPath(step.oldHostPath, args.workspaceRoot),
        nextPath: displayWorkspaceEditPath(step.newHostPath, args.workspaceRoot),
        addLines: 0,
        removeLines: 0,
        diff: null
      }
    }
    if (step.type === 'write') {
      const diff = diffLines(step.baseContent ?? '', step.nextContent)
      return {
        type: 'write',
        path: displayWorkspaceEditPath(step.hostPath, args.workspaceRoot),
        addLines: diff.filter((row) => row.kind === 'add').length,
        removeLines: diff.filter((row) => row.kind === 'remove').length,
        diff
      }
    }
    return {
      type: step.type,
      path: displayWorkspaceEditPath(step.hostPath, args.workspaceRoot),
      addLines: 0,
      removeLines: 0,
      diff: null,
      ...(step.type === 'create' ? { overwrite: step.overwrite } : {})
    }
  })
}

/** Host path → display path relative to the workspace root when inside it. */
export function displayWorkspaceEditPath(hostPath: string, workspaceRoot: string): string {
  const path = hostPath.replaceAll('\\', '/')
  const root = workspaceRoot.replaceAll('\\', '/')
  if (!root) {
    return path
  }
  // Windows drive roots are case-insensitive; POSIX roots are not.
  const windows = /^[A-Za-z]:/.test(root)
  const [haystack, needle] = windows ? [path.toLowerCase(), root.toLowerCase()] : [path, root]
  return haystack.startsWith(`${needle}/`) ? path.slice(root.length + 1) : path
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

function lcsRows(before: string[], after: string[]): WorkspaceEditDiffRow[] {
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return [
      ...before.map((text): WorkspaceEditDiffRow => ({ kind: 'remove', text })),
      ...after.map((text): WorkspaceEditDiffRow => ({ kind: 'add', text }))
    ]
  }
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const rows: WorkspaceEditDiffRow[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i] })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: 'remove', text: before[i] })
      i++
    } else {
      rows.push({ kind: 'add', text: after[j] })
      j++
    }
  }
  while (i < before.length) {
    rows.push({ kind: 'remove', text: before[i] })
    i++
  }
  while (j < after.length) {
    rows.push({ kind: 'add', text: after[j] })
    j++
  }
  return rows
}

function collapseContextRuns(rows: readonly WorkspaceEditDiffRow[]): WorkspaceEditDiffRow[] {
  const collapsed: WorkspaceEditDiffRow[] = []
  let run: WorkspaceEditDiffRow[] = []
  const flush = (): void => {
    if (run.length <= CONTEXT_RUN_LIMIT) {
      collapsed.push(...run)
    } else {
      collapsed.push(run[0], run[1], run[2], { kind: 'context', text: '…' }, ...run.slice(-3))
    }
    run = []
  }
  for (const row of rows) {
    if (row.kind === 'context') {
      run.push(row)
    } else {
      flush()
      collapsed.push(row)
    }
  }
  flush()
  return collapsed
}
