import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  CodeIntelligenceProbeResult,
  CodeIntelligenceScope,
  CodeIntelligenceScopeMember
} from '../../../../shared/code-intelligence-scope'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { SettingsSegmentedControl, SettingsSwitch } from './SettingsFormControls'

type Props = {
  scope: CodeIntelligenceScope
  onRefresh: () => Promise<void>
}

export function CodeIntelligenceScopeEditor({ scope, onRefresh }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(scope)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<CodeIntelligenceProbeResult | null>(null)
  useEffect(() => {
    setDraft(scope)
    setProbe(null)
  }, [scope])
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(scope), [draft, scope])

  const updateMember = (index: number, update: Partial<CodeIntelligenceScopeMember>): void => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member, memberIndex) =>
        memberIndex === index ? { ...member, ...update } : member
      )
    }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.codeIntelligence.upsertScope(draft)
      await onRefresh()
      toast.success(translate('settings.codeIntelligence.saved', 'Code intelligence scope saved'))
    } catch (error) {
      toast.error(translate('settings.codeIntelligence.saveFailed', 'Could not save scope'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setSaving(false)
    }
  }

  const grantConsent = async (): Promise<void> => {
    try {
      await window.api.codeIntelligence.grantConsent({
        scopeId: scope.id,
        revision: scope.revision
      })
      await onRefresh()
      toast.success(translate('settings.codeIntelligence.consentGranted', 'Launch allowed'))
    } catch (error) {
      toast.error(translate('settings.codeIntelligence.consentFailed', 'Could not allow launch'), {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const remove = async (): Promise<void> => {
    await window.api.codeIntelligence.removeScope(scope.id)
    await onRefresh()
  }

  const redetect = async (): Promise<void> => {
    setProbing(true)
    try {
      const result = await window.api.codeIntelligence.probeScope(scope.id)
      setProbe(result)
      if (result.available) {
        toast.success(translate('settings.codeIntelligence.detected', 'Language server detected'), {
          description: result.version
        })
      }
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">{draft.name}</p>
          <p className="text-xs text-muted-foreground">
            {draft.language === 'python'
              ? translate('settings.codeIntelligence.python', 'Python')
              : translate('settings.codeIntelligence.cpp', 'C++')}{' '}
            ? {draft.executionHostId}
          </p>
        </div>
        <SettingsSwitch
          checked={draft.enabled}
          ariaLabel={translate('settings.codeIntelligence.enabled', 'Enable scope')}
          onChange={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
        />
      </div>

      <div className="space-y-2">
        <Label>{translate('settings.codeIntelligence.members', 'Scope directories')}</Label>
        {draft.members.map((member, index) => (
          <div key={`member-${index}`} className="flex items-center gap-2">
            <Input
              value={member.relativePath}
              onChange={(event) => updateMember(index, { relativePath: event.target.value })}
              aria-label={translate('settings.codeIntelligence.memberPath', 'Scope directory')}
              className="h-8"
            />
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {translate('settings.codeIntelligence.showResults', 'Show results')}
              </span>
              <SettingsSwitch
                checked={member.visibleResults}
                ariaLabel={translate(
                  'settings.codeIntelligence.visibleResults',
                  'Show semantic results from this directory'
                )}
                onChange={() => updateMember(index, { visibleResults: !member.visibleResults })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={draft.members.length === 1}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  members: current.members.filter((_, memberIndex) => memberIndex !== index)
                }))
              }
              aria-label={translate('settings.codeIntelligence.removeMember', 'Remove directory')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              members: [...current.members, { relativePath: '.', visibleResults: true }]
            }))
          }
        >
          <Plus className="size-3.5" />
          {translate('settings.codeIntelligence.addMember', 'Add directory')}
        </Button>
      </div>

      <div className="space-y-2">
        <Label>{translate('settings.codeIntelligence.serverSource', 'Language server')}</Label>
        <SettingsSegmentedControl
          value={draft.serverSource.type === 'custom' ? 'custom' : 'automatic'}
          onChange={(value) =>
            setDraft((current) => ({
              ...current,
              serverSource:
                value === 'custom'
                  ? { type: 'custom', executable: '', args: [] }
                  : { type: 'automatic' }
            }))
          }
          ariaLabel={translate('settings.codeIntelligence.serverSource', 'Language server')}
          size="sm"
          options={[
            {
              value: 'automatic',
              label: translate('settings.codeIntelligence.automatic', 'Automatic')
            },
            { value: 'custom', label: translate('settings.codeIntelligence.custom', 'Custom') }
          ]}
        />
        {draft.serverSource.type === 'custom' ? (
          <div className="space-y-2 border-l border-border pl-4">
            <Input
              value={draft.serverSource.executable}
              placeholder={
                draft.language === 'python'
                  ? translate(
                      'settings.codeIntelligence.pythonExecutablePlaceholder',
                      'basedpyright-langserver'
                    )
                  : translate('settings.codeIntelligence.cppExecutablePlaceholder', 'clangd')
              }
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  serverSource: {
                    type: 'custom',
                    executable: event.target.value,
                    args: current.serverSource.type === 'custom' ? current.serverSource.args : []
                  }
                }))
              }
              aria-label={translate('settings.codeIntelligence.executable', 'Executable path')}
            />
            <Textarea
              value={draft.serverSource.args.join('\n')}
              placeholder={translate(
                'settings.codeIntelligence.argumentsPlaceholder',
                'One argument per line'
              )}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  serverSource: {
                    type: 'custom',
                    executable:
                      current.serverSource.type === 'custom' ? current.serverSource.executable : '',
                    args: event.target.value.split('\n').filter((value) => value.length > 0)
                  }
                }))
              }
              aria-label={translate('settings.codeIntelligence.arguments', 'Server arguments')}
              className="min-h-20 text-sm"
            />
          </div>
        ) : null}
      </div>

      {probe && !probe.available ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
          <p>{probe.message}</p>
          {probe.installCommand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void window.api.ui.writeClipboardText(probe.installCommand ?? '')}
            >
              {translate('settings.codeIntelligence.copyInstall', 'Copy install command')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {translate('settings.codeIntelligence.save', 'Save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={dirty || probing}
          onClick={() => void redetect()}
        >
          {probing
            ? translate('settings.codeIntelligence.detecting', 'Detecting...')
            : translate('settings.codeIntelligence.redetect', 'Re-detect')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={dirty}
          onClick={() => void grantConsent()}
        >
          {scope.consent
            ? translate('settings.codeIntelligence.reapprove', 'Re-allow launch')
            : translate('settings.codeIntelligence.allow', 'Allow launch')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void remove()}>
          {translate('settings.codeIntelligence.remove', 'Remove')}
        </Button>
      </div>
    </div>
  )
}
