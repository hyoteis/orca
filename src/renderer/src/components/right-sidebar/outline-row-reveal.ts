import type { OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { OutlineSymbolRow } from './outline-model'

/** Reveals an outline row in the active editor. Semantic and heuristic rows
 * alike jump in-file through the shared pending-reveal path (#98 reuses the
 * open tab); documentSymbol results are always same-file, so no cross-file
 * opener is needed. */
export function revealOutlineRow(
  row: OutlineSymbolRow,
  activeFile: OpenFile | null,
  setPendingEditorReveal: (reveal: PendingEditorReveal | null) => void
): void {
  if (!activeFile) {
    return
  }
  setPendingEditorReveal({
    filePath: activeFile.filePath,
    line: row.line,
    column: row.range.start.character + 1,
    matchLength: 0
  })
}
