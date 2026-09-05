import type { ActiveRightSidebarTab } from '../../../shared/types'
import { isPluginPanelTabKey } from '../../../shared/plugins/plugin-manifest'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
}

export type NormalizeRightSidebarRouteOptions = {
  /** Tab keys of currently installed plugin panels. When provided, persisted
   *  keys for UNINSTALLED plugins are dropped (reset to Explorer); merely
   *  disabled plugins keep their key and fall back at render time via
   *  resolveRightSidebarEffectiveTab. Omit when the installed list is not
   *  known yet (early hydration) — the render-time fallback still guards. */
  installedPluginTabKeys?: ReadonlySet<string>
}

export function normalizeRightSidebarRoute(
  tab: unknown,
  options?: NormalizeRightSidebarRouteOptions
): RightSidebarRoute {
  // Why: builds before #83 persisted the Code tab; Explorer absorbed it.
  if (tab === 'code') {
    return { rightSidebarTab: 'explorer' }
  }
  // Why: plugin tabs are open-ended keys; validate their shape so a persisted
  // plugin tab isn't reset to Explorer on restart.
  if (typeof tab === 'string' && isPluginPanelTabKey(tab)) {
    if (options?.installedPluginTabKeys && !options.installedPluginTabKeys.has(tab)) {
      return { rightSidebarTab: 'explorer' }
    }
    return { rightSidebarTab: tab as ActiveRightSidebarTab }
  }
  if (
    tab === 'explorer' ||
    tab === 'search' ||
    tab === 'vault' ||
    tab === 'workspaces' ||
    tab === 'pr-checks' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports'
  ) {
    return { rightSidebarTab: tab }
  }
  return { rightSidebarTab: 'explorer' }
}
