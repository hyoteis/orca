import { ipcMain } from 'electron'
import { grantCodeIntelligenceConsent } from '../language-server/code-intelligence-scope-consent'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
export function registerCodeIntelligenceHandlers(): void {
  ipcMain.handle('codeIntelligence:grantConsent', (_event, scope: CodeIntelligenceScope) =>
    grantCodeIntelligenceConsent(scope)
  )
}
