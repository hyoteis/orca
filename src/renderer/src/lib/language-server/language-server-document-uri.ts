import type { LanguageServerClientKey } from './language-server-client-registry'

export function toClientDocumentUri(key: LanguageServerClientKey, relativePath: string): string {
  const encodedPath = relativePath.split('\\').map(encodeURIComponent).join('/')
  return `orca-lsp://${encodeURIComponent(key.executionHostId)}/${encodeURIComponent(key.scopeId)}/${encodedPath}`
}

export function toServerFileUri(hostPath: string): string {
  const normalized = hostPath.replace(/\\/g, '/')
  const rooted = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized
  return `file://${rooted
    .split('/')
    .map((part, index) => (index === 0 ? '' : encodeURIComponent(part)))
    .join('/')}`
}
