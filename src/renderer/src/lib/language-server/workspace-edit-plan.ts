import type {
  CreateFile,
  DeleteFile,
  RenameFile,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver-protocol'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceEditBlockedTarget,
  WorkspaceEditPlannedStep,
  WorkspaceEditScopeRef
} from '../../../../shared/language-server-workspace-edit'
import { getDiskBaselineSignature } from '../../components/editor/diff-content-signature'
import { applyWorkspaceTextEdits } from './workspace-edit-text-application'
import { fileUriToHostPath } from './code-intelligence-workspace'
import { authorizeWorkspaceEditTargets } from './workspace-edit-path-authorization'

/** Open-editor + disk view the planner validates against (#23 blocking set). */
export type WorkspaceEditPlanView = {
  openDocumentFor(hostPath: string): {
    isDirty: boolean
    syncedText: string | null
    syncedVersion: number | null
  } | null
  readText(hostPath: string): Promise<string | null>
  exists(hostPath: string): Promise<boolean>
}

export type WorkspaceEditPlan =
  | { status: 'planned'; steps: WorkspaceEditPlannedStep[] }
  | { status: 'blocked'; blocks: WorkspaceEditBlockedTarget[] }

type PlanScope = Pick<WorkspaceEditScopeRef, 'executionHostId' | 'workspaceRoot' | 'members'>

/** LSP WorkspaceEdit → ordered guarded steps, or the blocking reasons. All-or-
 * nothing: any blocked target rejects the whole edit before a single write. */
export async function planWorkspaceEdit(args: {
  edit: WorkspaceEdit
  scope: PlanScope
  operationHostId: ExecutionHostId
  view: WorkspaceEditPlanView
}): Promise<WorkspaceEditPlan> {
  const authBlocks = new Map(
    authorizeWorkspaceEditTargets({
      scope: args.scope,
      operationHostId: args.operationHostId,
      targets: collectTargets(args.edit, args.scope)
    }).blocks.map((block) => [block.uri, block])
  )
  const blocks: WorkspaceEditBlockedTarget[] = []
  const steps: WorkspaceEditPlannedStep[] = []
  const writesByPath = new Map<string, Extract<WorkspaceEditPlannedStep, { type: 'write' }>>()
  const toHostPath = (uri: string): string => {
    // Authorization already rejected non-file URIs; null is unreachable here.
    return fileUriToHostPath(uri, args.scope.executionHostId) ?? uri
  }
  const blockedUri = (uri: string): boolean => {
    const block = authBlocks.get(uri)
    if (block) {
      blocks.push(block)
      return true
    }
    return false
  }

  const changes = args.edit.documentChanges ?? changesToDocumentChanges(args.edit)
  for (const change of changes) {
    if ('kind' in change) {
      if (change.kind === 'create') {
        if (blockedUri(change.uri)) {
          continue
        }
        const planned = await planCreate(change, toHostPath, args.view)
        if ('block' in planned) {
          blocks.push(planned.block)
        } else {
          steps.push(planned.step)
        }
        continue
      }
      if (change.kind === 'rename') {
        // Check both sides even when one is blocked so the report is complete.
        const oldBlocked = blockedUri(change.oldUri)
        const newBlocked = blockedUri(change.newUri)
        if (oldBlocked || newBlocked) {
          continue
        }
        const planned = await planRename(change, toHostPath, args.view)
        if ('block' in planned) {
          blocks.push(planned.block)
        } else {
          steps.push(planned.step)
        }
        continue
      }
      if (blockedUri(change.uri)) {
        continue
      }
      const planned = await planDelete(change, toHostPath, args.view)
      if ('block' in planned) {
        blocks.push(planned.block)
      } else {
        steps.push(planned.step)
      }
      continue
    }
    if (blockedUri(change.textDocument.uri)) {
      continue
    }
    const block = await planWrite(change, toHostPath(change.textDocument.uri), args.view, writesByPath, steps)
    if (block) {
      blocks.push(block)
    }
  }
  // All-or-nothing: the plan exists only when every target is clean.
  return blocks.length > 0 ? { status: 'blocked', blocks } : { status: 'planned', steps }
}

function collectTargets(edit: WorkspaceEdit, scope: PlanScope): {
  uri: string
  hostPath: string
}[] {
  const targets: { uri: string; hostPath: string }[] = []
  const add = (uri: string): void => {
    const hostPath = fileUriToHostPath(uri, scope.executionHostId)
    targets.push({ uri, hostPath: hostPath ?? uri })
  }
  const changes = edit.documentChanges ?? changesToDocumentChanges(edit)
  for (const change of changes) {
    if ('kind' in change) {
      if (change.kind === 'rename') {
        add(change.oldUri)
        add(change.newUri)
      } else {
        add(change.uri)
      }
    } else {
      add(change.textDocument.uri)
    }
  }
  return targets
}

function changesToDocumentChanges(edit: WorkspaceEdit): TextDocumentEdit[] {
  return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
    textDocument: { uri, version: null },
    edits
  }))
}

async function planWrite(
  change: TextDocumentEdit,
  hostPath: string,
  view: WorkspaceEditPlanView,
  writesByPath: Map<string, Extract<WorkspaceEditPlannedStep, { type: 'write' }>>,
  steps: WorkspaceEditPlannedStep[]
): Promise<WorkspaceEditBlockedTarget | null> {
  const open = view.openDocumentFor(hostPath)
  if (open?.isDirty) {
    return { uri: change.textDocument.uri, hostPath, reason: 'dirty-editor' }
  }
  const version = change.textDocument.version
  if (typeof version === 'number' && open?.syncedVersion != null && version !== open.syncedVersion) {
    return {
      uri: change.textDocument.uri,
      hostPath,
      reason: 'stale-version',
      detail: `document version ${version} ≠ synced version ${open.syncedVersion}`
    }
  }
  const existing = writesByPath.get(hostPath)
  const base = existing?.nextContent ?? open?.syncedText ?? (await safeReadText(hostPath, view))
  if (base === null) {
    return { uri: change.textDocument.uri, hostPath, reason: 'missing-target' }
  }
  if (base === undefined) {
    return { uri: change.textDocument.uri, hostPath, reason: 'unsupported-target' }
  }
  // ponytail: v1 applies plain/annotated text edits; snippet edits would need
  // client-side snippet expansion — block the document instead of guessing.
  const edits = change.edits.filter((candidate): candidate is TextEdit => 'newText' in candidate)
  if (edits.length !== change.edits.length) {
    return { uri: change.textDocument.uri, hostPath, reason: 'unsupported-target' }
  }
  const nextContent = applyWorkspaceTextEdits(base, edits)
  if (nextContent === null) {
    return { uri: change.textDocument.uri, hostPath, reason: 'edit-application' }
  }
  if (existing) {
    existing.nextContent = nextContent
    existing.documentVersion = existing.documentVersion ?? (typeof version === 'number' ? version : null)
    return null
  }
  const step: Extract<WorkspaceEditPlannedStep, { type: 'write' }> = {
    type: 'write',
    uri: change.textDocument.uri,
    hostPath,
    baseContent: base,
    baseSignature: getDiskBaselineSignature(base),
    nextContent,
    documentVersion: typeof version === 'number' ? version : null
  }
  writesByPath.set(hostPath, step)
  steps.push(step)
  return null
}

/** Distinguishes missing (null) from unreadable-directory (undefined) reads. */
async function safeReadText(
  hostPath: string,
  view: WorkspaceEditPlanView
): Promise<string | null | undefined> {
  try {
    return await view.readText(hostPath)
  } catch {
    return undefined
  }
}

async function planCreate(
  change: CreateFile,
  toHostPath: (uri: string) => string,
  view: WorkspaceEditPlanView
): Promise<{ step: WorkspaceEditPlannedStep } | { block: WorkspaceEditBlockedTarget }> {
  const hostPath = toHostPath(change.uri)
  const overwrite = change.options?.overwrite === true
  if (!overwrite && (await view.exists(hostPath))) {
    return {
      block: {
        uri: change.uri,
        hostPath,
        reason: 'existing-target'
      }
    }
  }
  return { step: { type: 'create', uri: change.uri, hostPath, overwrite } }
}

async function planRename(
  change: RenameFile,
  toHostPath: (uri: string) => string,
  view: WorkspaceEditPlanView
): Promise<{ step: WorkspaceEditPlannedStep } | { block: WorkspaceEditBlockedTarget }> {
  const oldHostPath = toHostPath(change.oldUri)
  const newHostPath = toHostPath(change.newUri)
  if (!(await view.exists(oldHostPath))) {
    return { block: { uri: change.oldUri, hostPath: oldHostPath, reason: 'missing-target' } }
  }
  // ponytail: v1 guards file targets only; directory renames can follow.
  if ((await safeReadText(oldHostPath, view)) === undefined) {
    return { block: { uri: change.oldUri, hostPath: oldHostPath, reason: 'unsupported-target' } }
  }
  const overwrite = change.options?.overwrite === true
  if (!overwrite && (await view.exists(newHostPath))) {
    return { block: { uri: change.newUri, hostPath: newHostPath, reason: 'existing-target' } }
  }
  return {
    step: {
      type: 'rename',
      oldUri: change.oldUri,
      newUri: change.newUri,
      oldHostPath,
      newHostPath,
      overwrite
    }
  }
}

async function planDelete(
  change: DeleteFile,
  toHostPath: (uri: string) => string,
  view: WorkspaceEditPlanView
): Promise<{ step: WorkspaceEditPlannedStep } | { block: WorkspaceEditBlockedTarget }> {
  const hostPath = toHostPath(change.uri)
  if (!(await view.exists(hostPath))) {
    return { block: { uri: change.uri, hostPath, reason: 'missing-target' } }
  }
  // ponytail: v1 guards file targets only; recursive directory deletes can follow.
  if ((await safeReadText(hostPath, view)) === undefined) {
    return { block: { uri: change.uri, hostPath, reason: 'unsupported-target' } }
  }
  return {
    step: {
      type: 'delete',
      uri: change.uri,
      hostPath,
      recursive: change.options?.recursive === true ? true : undefined
    }
  }
}

