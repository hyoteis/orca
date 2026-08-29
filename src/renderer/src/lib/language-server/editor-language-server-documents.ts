import type { OpenFile } from '@/store/slices/editor'
import type { LanguageServerDocumentSource } from './language-server-document-sync-controller'
import {
  isDocumentInCodeIntelligenceScope,
  type CodeIntelligenceMemberScope
} from './code-intelligence-scope-membership'

export function collectEditorLanguageServerDocuments(args: {
  openFiles: readonly OpenFile[]
  editorDrafts: Readonly<Record<string, string>>
  diskTextByFileId: Readonly<Record<string, string>>
  toUri: (file: OpenFile) => string
  acceptsLanguage: (language: string) => boolean
  scope: CodeIntelligenceMemberScope
}): LanguageServerDocumentSource[] {
  const collected = new Map<string, LanguageServerDocumentSource>()
  for (const file of args.openFiles) {
    if (
      file.mode !== 'edit' ||
      file.readOnly ||
      !args.acceptsLanguage(file.language) ||
      !isDocumentInCodeIntelligenceScope(args.scope, file.relativePath)
    ) {
      continue
    }
    const diskText = args.diskTextByFileId[file.id]
    const draftText = args.editorDrafts[file.id]
    if (diskText === undefined && draftText === undefined) {
      continue
    }
    const existing = collected.get(file.id)
    if (existing) {
      existing.references = (existing.references ?? 1) + 1
      continue
    }
    collected.set(file.id, {
      documentId: file.id,
      uri: args.toUri(file),
      languageId: file.language,
      diskText: diskText ?? draftText ?? '',
      draftText,
      references: 1
    })
  }
  return [...collected.values()]
}
