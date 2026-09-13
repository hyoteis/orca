import type { OpenFile } from '@/store/slices/editor'
import type { OutlineSymbolRow } from './outline-model'
import { extractHeuristicOutlineRows } from './outline-heuristics'
import { regroupQualifiedRows } from './outline-qualified-regroup'
import { semanticDocumentEditorFor } from '@/lib/language-server/semantic-monaco-documents'

/** Heuristic tier rows (ADR 0003 tier 3) from the live editor text; undefined
 * while the document is not mounted (no badge, plain status). Qualified
 * out-of-line definitions re-nest under their class (#105 follow-up). */
export function heuristicRowsFor(activeFile: OpenFile | null): OutlineSymbolRow[] | undefined {
  const document = activeFile && semanticDocumentEditorFor(activeFile.id)
  return document && activeFile
    ? regroupQualifiedRows(
        extractHeuristicOutlineRows(document.model.getValue(), activeFile.language)
      )
    : undefined
}
