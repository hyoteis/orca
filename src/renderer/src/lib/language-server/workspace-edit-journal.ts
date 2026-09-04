import { getDiskBaselineSignature } from '../../components/editor/diff-content-signature'
import type {
  WorkspaceEditBlockedTarget,
  WorkspaceEditPlannedStep
} from '../../../../shared/language-server-workspace-edit'
import type { JournalStep } from './workspace-edit-inverse'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'

// Journal execution primitives (#36): capture the preimage, commit one step,
// and restore committed steps in reverse. Split from the transaction engine so
// each file stays inside the max-lines tier.

export function hostPathOf(step: WorkspaceEditPlannedStep): string {
  return step.type === 'rename' ? step.oldHostPath : step.hostPath
}

export async function capturePreimage(
  step: WorkspaceEditPlannedStep,
  ports: WorkspaceEditTransactionPorts
): Promise<{ entry: Omit<JournalStep, 'status'> } | { block: WorkspaceEditBlockedTarget }> {
  if (step.type === 'write') {
    const content = await readPreimageContent(step.hostPath, ports)
    // The signature check doubles as the existence check: null content never matches.
    if (content === null ? step.baseContent !== null : getDiskBaselineSignature(content) !== step.baseSignature) {
      return {
        block: {
          uri: step.uri,
          hostPath: step.hostPath,
          reason: 'external-change',
          detail: 'disk content differs from the planned base'
        }
      }
    }
    return {
      entry: {
        step,
        preimage:
          content === null
            ? { kind: 'absent' }
            : { kind: 'content', content }
      }
    }
  }
  if (step.type === 'rename') {
    const oldContent = await readPreimageContent(step.oldHostPath, ports)
    if (oldContent === null) {
      return {
        block: { uri: step.oldUri, hostPath: step.oldHostPath, reason: 'unsupported-target' }
      }
    }
    const destination = (await ports.exists(step.newHostPath))
      ? await readPreimageContent(step.newHostPath, ports)
      : null
    return {
      entry: {
        step,
        preimage: { kind: 'content', content: oldContent },
        renameDestinationPreimage:
          destination === null ? { kind: 'absent' } : { kind: 'content', content: destination }
      }
    }
  }
  if (step.type === 'create') {
    const content = (await ports.exists(step.hostPath))
      ? await readPreimageContent(step.hostPath, ports)
      : null
    return {
      entry: {
        step,
        preimage: content === null ? { kind: 'absent' } : { kind: 'content', content }
      }
    }
  }
  const content = await readPreimageContent(step.hostPath, ports)
  if (content === null) {
    return {
      block: { uri: step.uri, hostPath: step.hostPath, reason: 'missing-target' }
    }
  }
  return { entry: { step, preimage: { kind: 'content', content } } }
}

async function readPreimageContent(
  hostPath: string,
  ports: WorkspaceEditTransactionPorts
): Promise<string | null> {
  try {
    return await ports.readText(hostPath)
  } catch {
    // v1 guards files; an unreadable target is a directory or host error.
    return null
  }
}

export async function commitStep(
  step: WorkspaceEditPlannedStep,
  ports: WorkspaceEditTransactionPorts
): Promise<void> {
  if (step.type === 'write') {
    return ports.writeAtomic(step.hostPath, step.nextContent)
  }
  if (step.type === 'create') {
    return step.overwrite ? ports.writeAtomic(step.hostPath, '') : ports.createFile(step.hostPath)
  }
  if (step.type === 'rename') {
    return ports.renamePath(step.oldHostPath, step.newHostPath)
  }
  return ports.deletePath(step.hostPath, step.recursive)
}

/** Restores committed steps in reverse; false when anything stayed behind. */
export async function rollbackJournal(
  journal: readonly JournalStep[],
  ports: WorkspaceEditTransactionPorts
): Promise<boolean> {
  let clean = true
  for (const entry of journal.toReversed()) {
    const { step, preimage } = entry
    try {
      if (step.type === 'rename') {
        await ports.renamePath(step.newHostPath, step.oldHostPath)
        if (entry.renameDestinationPreimage?.kind === 'content') {
          await ports.writeAtomic(step.newHostPath, entry.renameDestinationPreimage.content)
        }
      } else if (preimage.kind === 'content') {
        await ports.writeAtomic(hostPathOf(step), preimage.content)
      } else {
        await ports.deletePath(hostPathOf(step))
      }
      entry.status = 'rolled-back'
    } catch {
      clean = false
    }
  }
  return clean
}
