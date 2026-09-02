// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/types'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

const mockState = vi.hoisted(() => ({
  fetchSettings: vi.fn()
}))

const windowApi = vi.hoisted(() => ({
  codeIntelligence: { upsertScope: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof mockState) => T): T => selector(mockState),
    { getState: () => mockState }
  )
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { CodePanelAddFolderDialog } from './CodePanelAddFolderDialog'

afterEach(cleanup)

const CPP_SCOPE: CodeIntelligenceScope = {
  id: 'local:worktree:repo-1:cpp',
  name: 'repo-1 C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:repo-1',
  workspaceRoot: '/ws/repo-1',
  language: 'cpp',
  members: [{ path: 'src', visibleResults: true }],
  serverSource: { type: 'automatic' },
  consent: { configurationFingerprint: 'fp', grantedAt: 1, authorizedMembers: [] },
  enabled: true,
  revision: 1
}

const PYTHON_SCOPE: CodeIntelligenceScope = {
  ...CPP_SCOPE,
  id: 'local:worktree:repo-1:python',
  name: 'repo-1 Python',
  language: 'python'
}

const SEED = {
  repoId: 'repo-1',
  repoName: 'repo-1',
  repoPath: '/ws/repo-1',
  isFolder: false,
  executionHostId: 'local' as const
}

const dir = (name: string): DirEntry => ({ name, isDirectory: true, isSymlink: false })
const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })

function renderDialog(
  props: Partial<Parameters<typeof CodePanelAddFolderDialog>[0]> = {},
  listDirectory = vi
    .fn()
    .mockResolvedValue([dir('src'), dir('third_party'), file('README.md')])
): ReturnType<typeof render> {
  return render(
    <CodePanelAddFolderDialog
      onOpenChange={vi.fn()}
      scopes={[CPP_SCOPE]}
      scopeSeed={SEED}
      workspaceRootPath="/ws/repo-1"
      listDirectory={listDirectory}
      {...props}
    />
  )
}

function expandRoot(): void {
  fireEvent.click(screen.getAllByRole('button', { name: 'Expand folder' })[0]!)
}

function selectPath(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

function confirmAdd(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

function addCustomPath(path: string): void {
  fireEvent.change(
    screen.getByRole('textbox', { name: /Add a folder outside this workspace/ }),
    { target: { value: path } }
  )
  fireEvent.click(screen.getByRole('button', { name: /Add a folder outside this workspace/ }))
}

beforeEach(() => {
  mockState.fetchSettings.mockReset()
  windowApi.codeIntelligence.upsertScope.mockReset().mockResolvedValue({})
  ;(window as unknown as { api: typeof windowApi }).api = windowApi
})

describe('CodePanelAddFolderDialog tree picker', () => {
  it('lists the workspace root lazily with deferred feedback and nested expansion', async () => {
    let resolveRoot!: (entries: DirEntry[]) => void
    const listDirectory = vi
      .fn()
      .mockImplementationOnce(() => new Promise<DirEntry[]>((resolve) => (resolveRoot = resolve)))
      .mockResolvedValue([dir('include')])
    renderDialog({}, listDirectory)
    expandRoot()
    expect(listDirectory).toHaveBeenCalledWith('/ws/repo-1')
    expect(screen.getByText('Loading…')).toBeTruthy()
    resolveRoot([dir('src'), file('README.md')])
    expect(await screen.findByRole('button', { name: 'src' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand folder' })[1]!)
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith('/ws/repo-1/src'))
    expect(await screen.findByRole('button', { name: 'include' })).toBeTruthy()
  })

  it('requires a language pick when no scope exists', async () => {
    renderDialog({ scopes: [] })
    expandRoot()
    await screen.findByRole('button', { name: 'src' })
    selectPath('src')
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled)
      .toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'C++ scope' }))
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('defaults language checkboxes from existing scopes', () => {
    renderDialog({ scopes: [CPP_SCOPE, PYTHON_SCOPE] })
    expect(screen.getByRole('checkbox', { name: 'C++ scope' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByRole('checkbox', { name: 'Python scope' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('CodePanelAddFolderDialog add flow', () => {
  it('appends a tree selection to the existing scope and closes', async () => {
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    expandRoot()
    await screen.findByRole('button', { name: 'third_party' })
    selectPath('third_party')
    confirmAdd()
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(1))
    expect(windowApi.codeIntelligence.upsertScope.mock.calls[0]?.[0]).toMatchObject({
      id: 'local:worktree:repo-1:cpp',
      members: [
        { path: 'src', visibleResults: true },
        { path: 'third_party', visibleResults: true }
      ]
    })
    expect(mockState.fetchSettings).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('creates the missing scope for a checked language on first add', async () => {
    renderDialog({ scopes: [PYTHON_SCOPE] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'C++ scope' }))
    expandRoot()
    await screen.findByRole('button', { name: 'src' })
    selectPath('src')
    confirmAdd()
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(1))
    expect(windowApi.codeIntelligence.upsertScope.mock.calls[0]?.[0]).toMatchObject({
      id: 'local:worktree:repo-1:cpp',
      executionHostId: 'local',
      workspaceKey: 'worktree:repo-1',
      workspaceRoot: '/ws/repo-1',
      language: 'cpp',
      members: [{ path: 'src', visibleResults: true }],
      enabled: true
    })
  })

  it('adds the selection to every checked language scope', async () => {
    renderDialog({ scopes: [CPP_SCOPE, PYTHON_SCOPE] })
    expandRoot()
    await screen.findByRole('button', { name: 'third_party' })
    selectPath('third_party')
    confirmAdd()
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(2))
    const ids = windowApi.codeIntelligence.upsertScope.mock.calls.map(
      (call) => (call[0] as { id: string }).id
    )
    expect(ids).toEqual(['local:worktree:repo-1:cpp', 'local:worktree:repo-1:python'])
  })

  it('adds a custom absolute Host path to C++', async () => {
    renderDialog()
    addCustomPath('/opt/toolchain/sysroot')
    confirmAdd()
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(1))
    expect(windowApi.codeIntelligence.upsertScope.mock.calls[0]?.[0]).toMatchObject({
      members: [
        { path: 'src' },
        { path: '/opt/toolchain/sysroot', visibleResults: true }
      ]
    })
  })

  it('rejects absolute paths for python with a toast and writes nothing', async () => {
    const { toast } = await import('sonner')
    renderDialog({ scopes: [PYTHON_SCOPE] })
    addCustomPath('/opt/toolchain/sysroot')
    confirmAdd()
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(windowApi.codeIntelligence.upsertScope).not.toHaveBeenCalled()
  })

  it('rejects non-absolute custom paths before selection', async () => {
    const { toast } = await import('sonner')
    renderDialog()
    addCustomPath('third_party')
    expect(toast.error).toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('skips the write when the path is already governed', async () => {
    renderDialog()
    expandRoot()
    await screen.findByRole('button', { name: 'src' })
    selectPath('src')
    confirmAdd()
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'src' }) as HTMLElement).getAttribute(
        'aria-pressed'
      )).toBe('true')
    )
    // Give a would-be write a chance to land, then assert none did.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(windowApi.codeIntelligence.upsertScope).not.toHaveBeenCalled()
    expect(mockState.fetchSettings).not.toHaveBeenCalled()
  })

  it('toasts and stays open when the selection fails member normalization', async () => {
    const { toast } = await import('sonner')
    const onOpenChange = vi.fn()
    const listDirectory = vi.fn().mockResolvedValue([dir('~')])
    renderDialog({ onOpenChange }, listDirectory)
    expandRoot()
    await screen.findByRole('button', { name: '~' })
    selectPath('~')
    confirmAdd()
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(windowApi.codeIntelligence.upsertScope).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('restores a member to a kept-empty scope', async () => {
    renderDialog({ scopes: [{ ...CPP_SCOPE, members: [] }] })
    expandRoot()
    await screen.findByRole('button', { name: 'src' })
    selectPath('src')
    confirmAdd()
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(1))
    expect(windowApi.codeIntelligence.upsertScope.mock.calls[0]?.[0]).toMatchObject({
      id: 'local:worktree:repo-1:cpp',
      members: [{ path: 'src', visibleResults: true }]
    })
  })
})
