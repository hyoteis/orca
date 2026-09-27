import type { OpenFile } from '@/store/slices/editor'
import { semanticDocumentEditorFor } from '@/components/editor/semantic-monaco-documents'
import { extractHeuristicOutlineRows } from './outline-heuristics'
import { regroupQualifiedRows } from './outline-qualified-regroup'
import type { OutlineSymbolRow } from './outline-model'

/** Heuristic rows from the live editor text; undefined while the document is
 * not mounted (no badge, plain status). Qualified out-of-line definitions
 * re-nest under their class (#105 follow-up). */
export function heuristicRowsFor(activeFile: OpenFile | null): OutlineSymbolRow[] | undefined {
  const document = activeFile && semanticDocumentEditorFor(activeFile.filePath)
  return document && activeFile
    ? regroupQualifiedRows(
        extractHeuristicOutlineRows(document.model.getValue(), activeFile.language)
      )
    : undefined
}
