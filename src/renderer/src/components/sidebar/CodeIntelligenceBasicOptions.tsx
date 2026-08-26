import React from 'react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'

type CppStandard = 'c++17' | 'c++20' | 'c++23'

type Props = {
  additionalIncludes: string
  defines: string
  cppStandard: CppStandard
  onAdditionalIncludesChange: (value: string) => void
  onDefinesChange: (value: string) => void
  onCppStandardChange: (value: CppStandard) => void
}

export function CodeIntelligenceBasicOptions({
  additionalIncludes,
  defines,
  cppStandard,
  onAdditionalIncludesChange,
  onDefinesChange,
  onCppStandardChange
}: Props): React.JSX.Element {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground hover:bg-accent/40">
        {translate('settings.codeIntelligence.basicAdvanced', 'Advanced BASIC indexing options')}
      </summary>
      <div className="space-y-3 border-t border-border/60 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {translate(
            'settings.codeIntelligence.basicAdvancedDescription',
            'Used only when no complete CMake or GN build root is available.'
          )}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="code-intelligence-extra-includes" className="text-xs">
            {translate(
              'settings.codeIntelligence.additionalIncludes',
              'Additional include directories'
            )}
          </Label>
          <Textarea
            id="code-intelligence-extra-includes"
            value={additionalIncludes}
            className="min-h-16 font-mono text-xs"
            placeholder={translate('settings.codeIntelligence.onePathPerLine', 'One path per line')}
            onChange={(event) => onAdditionalIncludesChange(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="code-intelligence-defines" className="text-xs">
            {translate('settings.codeIntelligence.defines', 'Preprocessor definitions')}
          </Label>
          <Textarea
            id="code-intelligence-defines"
            value={defines}
            className="min-h-16 font-mono text-xs"
            placeholder={translate(
              'settings.codeIntelligence.oneDefinePerLine',
              'One definition per line, for example FEATURE_ENABLED=1'
            )}
            onChange={(event) => onDefinesChange(event.target.value)}
          />
        </div>
        <SettingsSegmentedControl
          value={cppStandard}
          onChange={(value) => onCppStandardChange(value as CppStandard)}
          ariaLabel={translate('settings.codeIntelligence.cppStandard', 'C++ standard')}
          options={[
            { value: 'c++17', label: 'C++17' },
            { value: 'c++20', label: 'C++20' },
            { value: 'c++23', label: 'C++23' }
          ]}
        />
      </div>
    </details>
  )
}
