import { describe, expect, it } from 'vitest'
import { normalizeRightSidebarRoute } from './right-sidebar-route'

describe('normalizeRightSidebarRoute', () => {
  it('maps the retired Code tab to Explorer (#83)', () => {
    expect(normalizeRightSidebarRoute('code')).toEqual({ rightSidebarTab: 'explorer' })
  })

  it('keeps Search as its own standalone tab', () => {
    expect(normalizeRightSidebarRoute('search')).toEqual({ rightSidebarTab: 'search' })
  })

  it('preserves the folder-only PR Checks route', () => {
    expect(normalizeRightSidebarRoute('pr-checks')).toEqual({ rightSidebarTab: 'pr-checks' })
  })

  it('still normalizes invalid tabs to Explorer', () => {
    expect(normalizeRightSidebarRoute('missing')).toEqual({ rightSidebarTab: 'explorer' })
  })

  it('preserves well-formed plugin panel tabs', () => {
    expect(normalizeRightSidebarRoute('plugin:orca-samples.my-plugin/dashboard')).toEqual({
      rightSidebarTab: 'plugin:orca-samples.my-plugin/dashboard'
    })
  })

  it('drops a well-formed tab once the installed plugin list proves it is stale', () => {
    expect(
      normalizeRightSidebarRoute('plugin:orca-samples.removed/dashboard', {
        installedPluginTabKeys: new Set(['plugin:orca-samples.present/dashboard'])
      })
    ).toEqual({ rightSidebarTab: 'explorer' })
  })

  it('normalizes malformed plugin tabs to Explorer', () => {
    expect(normalizeRightSidebarRoute('plugin:orca-samples.my-plugin')).toEqual({
      rightSidebarTab: 'explorer'
    })
    expect(normalizeRightSidebarRoute('plugin:orca-samples.my-plugin/panel/extra')).toEqual({
      rightSidebarTab: 'explorer'
    })
    expect(normalizeRightSidebarRoute('plugin:My_Plugin/Panel!')).toEqual({
      rightSidebarTab: 'explorer'
    })
  })
})
