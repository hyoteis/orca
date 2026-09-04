import { useState } from 'react'
import { Check, Copy, ExternalLink, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ManagedLanguageServerManifestEntry } from '../../../../shared/managed-language-server'

export function formatArchiveSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.max(1, Math.round(megabytes))} MB`
}

/** Offline archive picker filter, shared by the sheet input and the consent dialog. */
export const MANAGED_ARCHIVE_ACCEPT = '.zip,.gz,.tgz,.xz,.tar'

export function shortSha(sha: string): string {
  return `${sha.slice(0, 8)}…${sha.slice(-4)}`
}

function CopyButton({
  text,
  label,
  copiedLabel
}: {
  text: string
  label: string
  copiedLabel: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      aria-label={label}
      title={label}
      onClick={() => {
        void window.api.ui
          .writeClipboardText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {
            /* best-effort: clipboard can reject when unfocused */
          })
      }}
    >
      {copied ? (
        <Check className="size-3.5 text-status-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
      <span className="sr-only">{copied ? copiedLabel : label}</span>
    </Button>
  )
}

/** #21 expanded recovery: exact URL, suggested save location, and the
 * verified-artifact metadata (filename/size/SHA-256/platform) a manual
 * download needs before the client-file route can verify it. */
export function ManagedLanguageServerRecoveryDetails({
  entry,
  hostLabel,
  downloadsPath
}: {
  entry: ManagedLanguageServerManifestEntry
  hostLabel: string
  downloadsPath: string | null
}): React.JSX.Element {
  const platformLabel = `${entry.platform} · ${entry.arch}${
    entry.platform === 'linux' && entry.glibcFloor ? ` · glibc ≥ ${entry.glibcFloor}` : ''
  }`
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-background p-2 text-[11px]">
      <div className="flex items-start gap-1.5">
        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {translate('settings.codeIntelligence.managedInstall.downloadLink', 'Download link')}
          </div>
          <div className="truncate font-mono text-muted-foreground" title={entry.sourceUrl}>
            {entry.sourceUrl}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={translate('settings.codeIntelligence.managedInstall.openLink', 'Open download page')}
          title={translate('settings.codeIntelligence.managedInstall.openLink', 'Open download page')}
          onClick={() => void window.api.shell.openUrl(entry.sourceUrl)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <CopyButton
          text={entry.sourceUrl}
          label={translate('settings.codeIntelligence.managedInstall.copyLink', 'Copy link')}
          copiedLabel={translate('settings.codeIntelligence.managedInstall.copied', 'Copied')}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.saveTo', 'Save to')}
        </span>
        <span className="truncate font-mono">{downloadsPath ?? 'Downloads'}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.fileLabel', 'File')}
        </span>
        <span className="truncate font-mono" title={entry.archiveFileName}>
          {entry.archiveFileName}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.sizeLabel', 'Size')}
        </span>
        <span className="tabular-nums">{formatArchiveSize(entry.sizeBytes)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.shaLabel', 'SHA-256')}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono" title={entry.sha256}>
            {shortSha(entry.sha256)}
          </span>
          <CopyButton
            text={entry.sha256}
            label={translate(
              'settings.codeIntelligence.managedInstall.copySha',
              'Copy SHA-256'
            )}
            copiedLabel={translate('settings.codeIntelligence.managedInstall.copied', 'Copied')}
          />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.platformLabel', 'Artifact')}
        </span>
        <span className="truncate">{platformLabel}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {translate('settings.codeIntelligence.managedInstall.installOnLabel', 'Install on')}
        </span>
        <span className="truncate">{hostLabel}</span>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5 text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span>
          {translate(
            'settings.codeIntelligence.managedInstall.verifiedNotice',
            'Offline files are verified (size + SHA-256) before anything is extracted.'
          )}
        </span>
      </div>
    </div>
  )
}
