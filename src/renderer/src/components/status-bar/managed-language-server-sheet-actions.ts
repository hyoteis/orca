import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useAppStore } from '@/store'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { ManagedLanguageServerInstallResult } from '../../../../shared/managed-language-server'
import type { useManagedLanguageServerInstall } from './use-managed-language-server-install'
import type { ManagedInstallActionRoute } from './use-managed-language-server-install'

type ManagedInstallController = ReturnType<typeof useManagedLanguageServerInstall>

function toastInstallResult(result: ManagedLanguageServerInstallResult | null, label: string): void {
  if (!result) {
    return
  }
  if (result.status === 'installed') {
    toast.success(
      translate('settings.codeIntelligence.managedInstall.installedToast', '{{value0}} {{value1}} installed and active.', {
        value0: label,
        value1: result.version
      })
    )
  } else if (result.status === 'failed') {
    toast.error(
      translate('settings.codeIntelligence.managedInstall.installFailedToast', 'Install failed: {{value0}}', {
        value0: result.error
      })
    )
  } else if (result.status === 'canceled') {
    toast.info(translate('settings.codeIntelligence.managedInstall.canceledToast', 'Install canceled'))
  } else if (result.status === 'already-active') {
    toast.info(
      translate('settings.codeIntelligence.managedInstall.alreadyActiveToast', '{{value0}} is already active.', {
        value0: result.version
      })
    )
  }
}

/** Sheet actions: install (any route), rollback toasts, and the "Use managed"
 * scope switch that re-grants consent after the serverSource change. */
export function useManagedSheetActions({
  controller,
  label,
  toolScopes
}: {
  controller: ManagedInstallController
  label: string
  toolScopes: readonly CodeIntelligenceScope[]
}): {
  runInstall: (route: ManagedInstallActionRoute) => Promise<void>
  handleRollback: () => Promise<void>
  handleUseManaged: () => Promise<void>
  /** #21 policy: rollback failure expands the sheet; cleared by success. */
  rollbackFailure: string | null
} {
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const [rollbackFailure, setRollbackFailure] = useState<string | null>(null)

  const runInstall = useCallback(
    async (route: ManagedInstallActionRoute): Promise<void> => {
      try {
        toastInstallResult(await controller.install(route), label)
      } catch (error) {
        // Runtime-Host streams reject instead of returning a failed result.
        toast.error(
          translate('settings.codeIntelligence.managedInstall.installFailedToast', 'Install failed: {{value0}}', {
            value0: extractIpcErrorMessage(error, 'stream error')
          })
        )
      }
    },
    [controller, label]
  )

  const handleRollback = useCallback(async (): Promise<void> => {
    let result: Awaited<ReturnType<typeof controller.rollback>>
    try {
      result = await controller.rollback()
    } catch (error) {
      setRollbackFailure(
        translate('settings.codeIntelligence.managedInstall.rollbackFailedToast', 'Rollback failed: {{value0}}', {
          value0: extractIpcErrorMessage(error, 'stream error')
        })
      )
      return
    }
    if (!result) {
      return
    }
    if (result.status === 'rolled-back') {
      setRollbackFailure(null)
      toast.success(
        translate('settings.codeIntelligence.managedInstall.rolledBackToast', 'Rolled back to {{value0}}', {
          value0: result.version
        })
      )
    } else if (result.status === 'failed') {
      setRollbackFailure(
        translate('settings.codeIntelligence.managedInstall.rollbackFailedToast', 'Rollback failed: {{value0}}', {
          value0: result.error
        })
      )
    } else {
      toast.info(
        translate('settings.codeIntelligence.managedInstall.noRollbackToast', 'No retained rollback version')
      )
    }
  }, [controller])

  const handleUseManaged = useCallback(async (): Promise<void> => {
    try {
      for (const scope of toolScopes.filter((scope) => scope.serverSource.type !== 'managed')) {
        const saved = await window.api.codeIntelligence.upsertScope({
          ...scope,
          serverSource: { type: 'managed' }
        })
        // Same grant entry the setup dialog uses — serverSource changes need consent.
        await window.api.codeIntelligence.grantConsent({
          scopeId: saved.id,
          revision: saved.revision
        })
      }
      toast.success(
        translate('settings.codeIntelligence.managedInstall.useManagedDone', '{{value0}} scopes now use the managed server; new sessions pick it up.', {
          value0: label
        })
      )
    } catch (error) {
      toast.error(
        extractIpcErrorMessage(
          error,
          translate('settings.codeIntelligence.managedInstall.useManagedFailed', 'Could not switch scopes to the managed server')
        )
      )
    }
    await fetchSettings()
    await controller.refresh()
  }, [controller, label, toolScopes, fetchSettings])

  return { runInstall, handleRollback, handleUseManaged, rollbackFailure }
}
