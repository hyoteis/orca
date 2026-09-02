import type * as Monaco from 'monaco-editor'
import { translate } from '@/i18n/i18n'

type MonacoApi = typeof Monaco

export type DefinitionAffordanceHandlers<Request, Target> = {
  resolve: (request: Request) => Promise<Target | null>
  open: (request: Request, target: Target) => boolean
  /** Explicit navigation that resolved to nothing (hover decoration stays silent). */
  onNoResult?: (request: Request, word: string | null) => void
  /** Distinct action id so language siblings can coexist on one editor. */
  actionId?: string
}

type ModifierState = { ctrlKey: boolean; metaKey: boolean }

export function isDefinitionModifierPressed(userAgent: string, event: ModifierState): boolean {
  return userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
}

export function installDefinitionLinkAffordance<Request, Target>(
  monaco: MonacoApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: (position: Monaco.IPosition) => Request | null,
  handlers: DefinitionAffordanceHandlers<Request, Target>
): () => void {
  const decorations = editor.createDecorationsCollection()
  let hoveredPosition: Monaco.IPosition | null = null
  let activeKey = ''
  let activeTarget: Target | null = null
  let requestGeneration = 0

  const clear = (): void => {
    requestGeneration += 1
    activeKey = ''
    activeTarget = null
    decorations.clear()
  }

  const wordAt = (position: Monaco.IPosition): string | null =>
    editor.getModel()?.getWordAtPosition(position)?.word ?? null

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
    const target = await handlers.resolve(request)
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
    id: handlers.actionId ?? 'orca.goToDefinition',
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
      const target = await handlers.resolve(request)
      if (target) {
        handlers.open(request, target)
      } else {
        handlers.onNoResult?.(request, position ? wordAt(position) : null)
      }
    }
  })

  const mouseMove = editor.onMouseMove((event) => {
    hoveredPosition = event.target.position ?? null
    if (
      event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT ||
      !hoveredPosition ||
      !isDefinitionModifierPressed(navigator.userAgent, event.event)
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
      !isDefinitionModifierPressed(navigator.userAgent, event.event)
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
      handlers.open(request, activeTarget)
      return
    }
    void handlers.resolve(request).then((target) => {
      if (target) {
        handlers.open(request, target)
      } else {
        handlers.onNoResult?.(request, wordAt(position))
      }
    })
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    if (hoveredPosition && isDefinitionModifierPressed(navigator.userAgent, event)) {
      void showLink(hoveredPosition)
    }
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!isDefinitionModifierPressed(navigator.userAgent, event)) {
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
