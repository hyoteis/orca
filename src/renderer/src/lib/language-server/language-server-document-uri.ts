import type { LanguageServerClientKey } from './language-server-client-registry'

export function toClientDocumentUri(key: LanguageServerClientKey, relativePath: string): string {
  const encodedPath = relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return `orca-lsp://${encodeURIComponent(key.executionHostId)}/${encodeURIComponent(key.scopeId)}/${encodedPath}`
}

export function toServerFileUri(hostPath: string): string {
  const normalized = hostPath.replace(/\\/g, '/')
  if (normalized.startsWith('//')) {
    const [authority, ...parts] = normalized.slice(2).split('/')
    const url = new URL('file:///')
    url.hostname = authority
    url.pathname = `/${parts.join('/')}`
    return url.href
  }
  const url = new URL('file:///')
  url.pathname = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized
  return url.href
}
