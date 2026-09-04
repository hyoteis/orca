import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Command-only actions need a second confirmation showing server + command (#20). */
export function confirmServerCommandViaToast(args: {
  serverLabel: string
  command: string
  title: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    toast.info(
      translate(
        'settings.codeIntelligence.serverCommandConfirmPrompt',
        '“{{value0}}” wants to run “{{value1}}” ({{value2}}). Run it?',
        { value0: args.title, value1: args.command, value2: args.serverLabel }
      ),
      {
        duration: Infinity,
        dismissible: true,
        action: {
          label: translate('settings.codeIntelligence.serverCommandRun', 'Run'),
          onClick: () => finish(true)
        },
        onDismiss: () => finish(false),
        onAutoClose: () => finish(false)
      }
    )
  })
}
