import type * as Monaco from 'monaco-editor'
import { translate } from '@/i18n/i18n'
import type { CppDefinitionTarget } from './cpp-definition-locations'
import {
  openCppDefinitionTarget,
  resolveCppDefinition,
  type CppCodeIntelligenceRequest
} from './cpp-definition-navigation'

type MonacoApi = typeof Monaco
type RequestAt = (position: Monaco.IPosition) => CppCodeIntelligenceRequest | null

type ModifierState = { ctrlKey: boolean; metaKey: boolean }

export function isCppDefinitionModifierPressed(userAgent: string, event: ModifierState): boolean {
  return userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
}

export function installCppDefinitionLinkAffordance(
  monaco: MonacoApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: RequestAt
): () => void {
  const decorations = editor.createDecorationsCollection()
  let hoveredPosition: Monaco.IPosition | null = null
  let activeKey = ''
  let activeTarget: CppDefinitionTarget | null = null
  let requestGeneration = 0

  const clear = (): void => {
    requestGeneration += 1
    activeKey = ''
    activeTarget = null
    decorations.clear()
  }

  const showLink = async (position: Monaco.IPosition): Promise<void> => {
    const model = editor.getModel()
    const word = model?.getWordAtPosition(position)
    const request = word ? requestAt(position) : null
    if (!model || !word || !request) {
      clear()
      return
    }
    const key = `${model.uri.toString()}:${model.getVersionId()}:${position.lineNumber}:${word.startColumn}:${word.endColumn}`
    if (key === activeKey) {
      return
    }
    const generation = ++requestGeneration
    activeKey = key
    activeTarget = null
    decorations.clear()
    const target = await resolveCppDefinition(request)
    if (generation !== requestGeneration || key !== activeKey) {
      return
    }
    activeTarget = target
    if (!target) {
      return
    }
    decorations.set([
      {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        ),
        options: { inlineClassName: 'orca-definition-link' }
      }
    ])
  }

  const goToDefinitionAction = editor.addAction({
    id: 'orca.goToDefinition',
    label: translate('settings.codeIntelligence.goToDefinition', 'Go to Definition'),
    keybindings: [monaco.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: async () => {
      const position = editor.getPosition()
      const request = position ? requestAt(position) : null
      if (!request) {
        return
      }
      const target = await resolveCppDefinition(request)
      if (target) {
        openCppDefinitionTarget(request, target)
      }
    }
  })

  const mouseMove = editor.onMouseMove((event) => {
    hoveredPosition = event.target.position ?? null
    if (
      event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT ||
      !hoveredPosition ||
      !isCppDefinitionModifierPressed(navigator.userAgent, event.event)
    ) {
      clear()
      return
    }
    void showLink(hoveredPosition)
  })
  const mouseLeave = editor.onMouseLeave(() => {
    hoveredPosition = null
    clear()
  })
  const mouseDown = editor.onMouseDown((event) => {
    const position = event.target.position
    if (
      !position ||
      !event.event.leftButton ||
      !isCppDefinitionModifierPressed(navigator.userAgent, event.event)
    ) {
      return
    }
    const request = requestAt(position)
    if (!request) {
      return
    }
    event.event.preventDefault()
    event.event.stopPropagation()
    editor.setPosition(position)
    if (activeTarget) {
      openCppDefinitionTarget(request, activeTarget)
      return
    }
    void resolveCppDefinition(request).then((target) => {
      if (target) {
        openCppDefinitionTarget(request, target)
      }
    })
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    if (hoveredPosition && isCppDefinitionModifierPressed(navigator.userAgent, event)) {
      void showLink(hoveredPosition)
    }
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!isCppDefinitionModifierPressed(navigator.userAgent, event)) {
      clear()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  return () => {
    goToDefinitionAction.dispose()
    mouseMove.dispose()
    mouseLeave.dispose()
    mouseDown.dispose()
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    decorations.clear()
  }
}
