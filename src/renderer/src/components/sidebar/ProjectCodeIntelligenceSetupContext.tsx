import type { ReactElement } from 'react'
import { Braces } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'

type Props = { repoId?: string; children: ReactElement }

export function ProjectCodeIntelligenceSetupContext({
  repoId,
  children
}: Props): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  if (!repoId) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openModal('code-intelligence-cmake-setup', { repoId })}>
          <Braces className="size-3.5" />
          {translate('settings.codeIntelligence.setupMenu', 'Set up C++ code intelligence')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
