import React from 'react'
import { translate } from '@/i18n/i18n'

type CppStandard = 'c++17' | 'c++20' | 'c++23'

/** Configure Code dialog's BASIC-mode form: include dirs, defines, standard.
 * Pure presentational — state lives in the dialog. */
export function ConfigureBasicOptionsForm({
  includeText,
  definesText,
  cppStandard,
  onIncludeChange,
  onDefinesChange,
  onStandardChange
}: {
  includeText: string
  definesText: string
  cppStandard: CppStandard
  onIncludeChange: (next: string) => void
  onDefinesChange: (next: string) => void
  onStandardChange: (next: CppStandard) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <label className="block text-[11px] text-muted-foreground" htmlFor="configure-includes">
        {translate('settings.codeIntelligence.basicIncludes', 'Include directories (one -I per line)')}
      </label>
      <textarea
        id="configure-includes"
        className="min-h-14 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
        value={includeText}
        onChange={(event) => onIncludeChange(event.target.value)}
      />
      <label className="block text-[11px] text-muted-foreground" htmlFor="configure-defines">
        {translate('settings.codeIntelligence.basicDefines', 'Defines (one -D per line)')}
      </label>
      <textarea
        id="configure-defines"
        className="min-h-10 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
        value={definesText}
        onChange={(event) => onDefinesChange(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-muted-foreground" htmlFor="configure-standard">
          {translate('settings.codeIntelligence.basicStandard', 'C++ standard')}
        </label>
        <select
          id="configure-standard"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          value={cppStandard}
          onChange={(event) => onStandardChange(event.target.value as CppStandard)}
        >
          <option value="c++17">C++17</option>
          <option value="c++20">C++20</option>
          <option value="c++23">C++23</option>
        </select>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {translate(
          'settings.codeIntelligence.basicNote',
          'Applies to the whole workspace; the compile-database mode ignores these options.'
        )}
      </p>
    </div>
  )
}
