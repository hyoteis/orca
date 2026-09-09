import type { OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { openDefinitionTargetInWorkspace } from '@/lib/language-server/code-intelligence-workspace'
import { toServerFileUri } from '@/lib/language-server/language-server-document-uri'
import type { OutlineSymbolRow } from './outline-model'

/** Semantic rows reveal through the shared symbol-open path (reuses the open
 * tab, #98); heuristic rows — no scope backs them — reveal by line (#103). */
export function revealOutlineRow(
  row: OutlineSymbolRow,
  activeFile: OpenFile | null,
  scope: CodeIntelligenceScope | null,
  semantic: boolean,
  setPendingEditorReveal: (reveal: PendingEditorReveal | null) => void
): void {
  if (!activeFile) {
    return
  }
  if (semantic && scope) {
    openDefinitionTargetInWorkspace(
      {
        filePath: activeFile.filePath,
        relativePath: activeFile.relativePath,
        worktreeId: activeFile.worktreeId
      },
      { uri: toServerFileUri(activeFile.filePath), range: row.range },
      scope
    )
    return
  }
  setPendingEditorReveal({
    filePath: activeFile.filePath,
    line: row.line,
    column: row.range.start.character + 1,
    matchLength: 0
  })
}
