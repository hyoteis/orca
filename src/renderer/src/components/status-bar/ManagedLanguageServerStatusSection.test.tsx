// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type {
  ManagedLanguageServerInstallEvent,
  ManagedLanguageServerInstallState
} from '../../../../shared/managed-language-server'
import { ManagedLanguageServerStatusSection } from './ManagedLanguageServerStatusSection'
import { useAppStore } from '@/store'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

const {
  managedInstallStateMock,
  installMock,
  cancelMock,
  rollbackMock,
  upsertScopeMock,
  grantConsentMock,
  downloadsPathMock,
  localFilePathForMock,
  writeClipboardMock,
  openUrlMock
} = vi.hoisted(() => ({
  managedInstallStateMock: vi.fn(),
  installMock: vi.fn(),
  cancelMock: vi.fn(),
  rollbackMock: vi.fn(),
  upsertScopeMock: vi.fn(),
  grantConsentMock: vi.fn(),
  downloadsPathMock: vi.fn(),
  localFilePathForMock: vi.fn(),
  writeClipboardMock: vi.fn(),
  openUrlMock: vi.fn()
}))

let eventListener: ((event: ManagedLanguageServerInstallEvent) => void) | null = null

const entry = {
  id: 'clangd-22.1.6-linux-x64',
  tool: 'clangd' as const,
  version: '22.1.6',
  platform: 'linux' as const,
  arch: 'x64' as const,
  glibcFloor: '2.31',
  sourceUrl: 'https://releases.example/clangd-22.1.6.tar.xz',
  archiveFileName: 'clangd-22.1.6.tar.xz',
  archiveFormat: 'tar-xz' as const,
  sizeBytes: 193_273_528,
  sha256: 'a8d091fe'.padEnd(64, '0'),
  archiveRootDirectory: '.',
  probe: { executable: '{root}/clangd', args: ['--version'] },
  command: { executable: '{root}/clangd', args: [] },
  license: { name: 'Apache-2.0', url: 'https://licenses.example/apache' }
}

const state = (
  overrides: Partial<ManagedLanguageServerInstallState> = {}
): ManagedLanguageServerInstallState => ({
  tool: 'clangd',
  supported: true,
  activeVersion: null,
  rollbackVersion: null,
  installedVersions: [],
  latestEntry: entry,
  updateAvailable: false,
  ...overrides
})

const scope = (
  language: 'cpp' | 'python',
  executionHostId: string,
  serverSource: CodeIntelligenceScope['serverSource'] = { type: 'automatic' }
): CodeIntelligenceScope => ({
  id: `${executionHostId}:worktree:demo:${language}`,
  name: 'demo',
  executionHostId: executionHostId as CodeIntelligenceScope['executionHostId'],
  workspaceKey: 'worktree:demo',
  workspaceRoot: '/repo',
  language,
  members: [{ path: '.', visibleResults: true }],
  serverSource,
  enabled: true,
  revision: 1
})

const initialState = useAppStore.getInitialState()

function mountSection(
  scopes: CodeIntelligenceScope[],
  executionHostId: string
): void {
  useAppStore.setState({ fetchSettings: vi.fn().mockResolvedValue(undefined) })
  render(
    <ManagedLanguageServerStatusSection
      scopes={scopes}
      executionHostId={executionHostId as CodeIntelligenceScope['executionHostId']}
    />
  )
}

beforeEach(() => {
  eventListener = null
  ;(window as unknown as { api: unknown }).api = {
    codeIntelligence: {
      managedInstallState: managedInstallStateMock,
      installManagedLanguageServer: installMock,
      cancelManagedLanguageServerInstall: cancelMock,
      rollbackManagedLanguageServer: rollbackMock,
      upsertScope: upsertScopeMock,
      grantConsent: grantConsentMock,
      managedInstallDownloadsPath: downloadsPathMock,
      localFilePathForFile: localFilePathForMock,
      onManagedInstallEvent: (callback: (event: ManagedLanguageServerInstallEvent) => void) => {
        eventListener = callback
        return () => {}
      }
    },
    ui: { writeClipboardText: writeClipboardMock },
    shell: { openUrl: openUrlMock }
  }
  downloadsPathMock.mockResolvedValue('C:/Users/orca/Downloads')
  grantConsentMock.mockResolvedValue(undefined)
  upsertScopeMock.mockImplementation((updated: CodeIntelligenceScope) =>
    Promise.resolve({ ...updated, revision: updated.revision + 1 })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAppStore.setState(initialState, true)
})

const emitEvent = (event: ManagedLanguageServerInstallEvent): void => {
  act(() => {
    eventListener?.(event)
  })
}

describe('ManagedLanguageServerStatusSection', () => {
  it('renders one sheet per scope language', async () => {
    managedInstallStateMock.mockResolvedValue(state())
    mountSection([scope('cpp', 'local'), scope('python', 'local')], 'local')
    expect(await screen.findByText('clangd')).toBeTruthy()
    expect(await screen.findByText('BasedPyright')).toBeTruthy()
    expect(managedInstallStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'local', tool: 'clangd' })
    )
  })

  it('first install goes through the focused consent dialog', async () => {
    managedInstallStateMock.mockResolvedValue(state())
    mountSection([scope('cpp', 'ssh:host-a')], 'ssh:host-a')
    fireEvent.click(await screen.findByText('clangd'))
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }))
    // Focused task: artifact summary before any install call.
    expect(await screen.findByText(/Apache-2\.0/)).toBeTruthy()
    expect(screen.getByText(/never touched/)).toBeTruthy()
    expect(installMock).not.toHaveBeenCalled()
    installMock.mockResolvedValue({ status: 'installed', version: '22.1.6' })
    fireEvent.click(screen.getByRole('button', { name: 'Install clangd' }))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith({
        executionHostId: 'ssh:host-a',
        tool: 'clangd',
        version: undefined,
        route: { type: 'host-download' }
      })
    )
    expect(toast.success).toHaveBeenCalled()
  })

  it('installing shows byte progress and cancel', async () => {
    managedInstallStateMock.mockResolvedValue(state({ activeVersion: '22.1.6', installedVersions: ['22.1.6'] }))
    mountSection([scope('cpp', 'ssh:host-b')], 'ssh:host-b')
    await screen.findByText('clangd · 22.1.6')
    emitEvent({
      executionHostId: 'ssh:host-b',
      tool: 'clangd',
      version: '23.0.0',
      phase: 'download',
      receivedBytes: 96_636_764,
      totalBytes: 193_273_528
    })
    expect(await screen.findByText(/Downloading/)).toBeTruthy()
    expect(screen.getByText(/50%/)).toBeTruthy()
    // #15 safety: the running version stays visible.
    expect(screen.getByText(/22\.1\.6 stays active/)).toBeTruthy()
    cancelMock.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith({ executionHostId: 'ssh:host-b', tool: 'clangd' })
    )
  })

  it('failure auto-expands with exact recovery guidance, retry, and offline select', async () => {
    managedInstallStateMock.mockResolvedValue(
      state({ activeVersion: '22.1.6', installedVersions: ['22.1.6'] })
    )
    mountSection([scope('cpp', 'ssh:host-c')], 'ssh:host-c')
    await screen.findByText('clangd · 22.1.6')
    emitEvent({
      executionHostId: 'ssh:host-c',
      tool: 'clangd',
      version: '23.0.0',
      phase: 'error',
      message: 'curl exited 56'
    })
    // Auto-expanded recovery (#21 interruption policy).
    expect(await screen.findByText('https://releases.example/clangd-22.1.6.tar.xz')).toBeTruthy()
    expect(screen.getByTitle('clangd-22.1.6.tar.xz')).toBeTruthy()
    expect(screen.getByText(/184 MB/)).toBeTruthy()
    expect(screen.getByText(/a8d091fe…0000/)).toBeTruthy()
    expect(screen.getByText(/Save to/)).toBeTruthy()
    expect(screen.getByText(/curl exited 56/)).toBeTruthy()
    expect(screen.getByText(/22\.1\.6 stays active/)).toBeTruthy()
    installMock.mockResolvedValue({ status: 'installed', version: '22.1.6' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry download' }))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith(
        expect.objectContaining({ route: { type: 'host-download' } })
      )
    )
    // Offline route: pick a downloaded file → client-file upload.
    installMock.mockClear()
    localFilePathForMock.mockReturnValue('C:/Users/orca/Downloads/clangd-22.1.6.tar.xz')
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File([], 'clangd-22.1.6.tar.xz')] }
    })
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith(
        expect.objectContaining({
          route: {
            type: 'client-file',
            filePath: 'C:/Users/orca/Downloads/clangd-22.1.6.tar.xz'
          }
        })
      )
    )
    // Offline reload: a repeat failure offers the remembered archive again.
    installMock.mockClear()
    emitEvent({
      executionHostId: 'ssh:host-c',
      tool: 'clangd',
      version: '22.1.6',
      phase: 'error',
      message: 'sha256 mismatch'
    })
    fireEvent.click(screen.getByRole('button', { name: /Reload clangd-22\.1\.6\.tar\.xz/ }))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith(
        expect.objectContaining({
          route: {
            type: 'client-file',
            filePath: 'C:/Users/orca/Downloads/clangd-22.1.6.tar.xz'
          }
        })
      )
    )
  })

  it('offers update and rollback on an active install', async () => {
    managedInstallStateMock.mockResolvedValue(
      state({
        activeVersion: '22.1.6',
        rollbackVersion: '21.1.2',
        installedVersions: ['22.1.6', '21.1.2'],
        updateAvailable: true
      })
    )
    mountSection([scope('cpp', 'ssh:host-d')], 'ssh:host-d')
    const header = await screen.findByText('clangd · 22.1.6')
    fireEvent.click(header)
    installMock.mockResolvedValue({ status: 'installed', version: '23.0.0' })
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith(
        expect.objectContaining({ route: { type: 'host-download' } })
      )
    )
    rollbackMock.mockResolvedValue({ status: 'rolled-back', version: '21.1.2' })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to 21.1.2' }))
    await waitFor(() =>
      expect(rollbackMock).toHaveBeenCalledWith({ executionHostId: 'ssh:host-d', tool: 'clangd' })
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('shows busy feedback when the Host streams no intermediate events', async () => {
    let resolveInstall: (value: { status: string; version: string }) => void = () => {}
    installMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve
      })
    )
    managedInstallStateMock.mockResolvedValue(
      state({ activeVersion: '22.1.6', installedVersions: ['22.1.6'], updateAvailable: true })
    )
    mountSection([scope('cpp', 'ssh:host-g')], 'ssh:host-g')
    fireEvent.click(await screen.findByText('clangd · 22.1.6'))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    // No download event was emitted — busy itself must render a spinner row.
    expect(await screen.findByText('Working…')).toBeTruthy()
    resolveInstall({ status: 'installed', version: '23.0.0' })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('a canceled first install keeps the Install entry reachable', async () => {
    managedInstallStateMock.mockResolvedValue(state())
    mountSection([scope('cpp', 'ssh:host-h')], 'ssh:host-h')
    fireEvent.click(await screen.findByText('clangd'))
    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }))
    expect(await screen.findByText(/Apache-2\.0/)).toBeTruthy()
    // Close the focused task, then the Host cancels the running install.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    emitEvent({
      executionHostId: 'ssh:host-h',
      tool: 'clangd',
      version: '22.1.6',
      phase: 'error',
      canceled: true
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Install$/ })).toBeTruthy()
    )
  })

  it('a failed rollback expands the sheet with an alert', async () => {
    managedInstallStateMock.mockResolvedValue(
      state({
        activeVersion: '22.1.6',
        rollbackVersion: '21.1.2',
        installedVersions: ['22.1.6', '21.1.2']
      })
    )
    rollbackMock.mockResolvedValue({ status: 'failed', error: 'active.json busy' })
    mountSection([scope('cpp', 'ssh:host-i')], 'ssh:host-i')
    fireEvent.click(await screen.findByText('clangd · 22.1.6'))
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to 21.1.2' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/active\.json busy/)).toBeTruthy()
  })

  it('unsupported hosts explain the reason and the Phase 1 fallback', async () => {
    managedInstallStateMock.mockResolvedValue(
      state({
        supported: false,
        unsupportedReason: { type: 'unsupported-glibc', glibcVersion: '2.17', floor: '2.31' },
        latestEntry: null
      })
    )
    mountSection([scope('cpp', 'ssh:host-e')], 'ssh:host-e')
    expect(await screen.findByText(/glibc 2\.17/)).toBeTruthy()
    expect(screen.getByText(/PATH-discovered or custom executables/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Install$/ })).toBeNull()
  })

  it('Use managed switches scopes and regrants consent', async () => {
    managedInstallStateMock.mockResolvedValue(
      state({ activeVersion: '22.1.6', installedVersions: ['22.1.6'] })
    )
    mountSection([scope('cpp', 'ssh:host-f')], 'ssh:host-f')
    fireEvent.click(await screen.findByText('clangd · 22.1.6'))
    fireEvent.click(
      screen.getByRole('button', { name: /Use managed server for clangd scopes here/ })
    )
    await waitFor(() =>
      expect(upsertScopeMock).toHaveBeenCalledWith(
        expect.objectContaining({ serverSource: { type: 'managed' } })
      )
    )
    await waitFor(() =>
      expect(grantConsentMock).toHaveBeenCalledWith({ scopeId: 'ssh:host-f:worktree:demo:cpp', revision: 2 })
    )
    expect(toast.success).toHaveBeenCalled()
  })
})
