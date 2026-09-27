import { describe, expect, it, vi } from 'vitest'
import { toEditorModelUri } from './editor-model-uri'
import {
  registerSemanticMonacoDocument,
  semanticDocumentEditorFor,
  subscribeSemanticDocuments,
  type SemanticMonacoModel
} from './semantic-monaco-documents'

function makeModel(uri: string, text = ''): SemanticMonacoModel {
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    onDidChangeContent: () => ({ dispose: () => {} })
  }
}

function makeEditor(model: SemanticMonacoModel | null) {
  return {
    getModel: () => model,
    onDidChangeCursorPosition: () => ({ dispose: () => {} })
  }
}

describe('registerSemanticMonacoDocument', () => {
  it('registers by model uri and unregisters the same entry', () => {
    const uri = toEditorModelUri('C:/repo/one.cpp')
    const editor = makeEditor(makeModel(uri, 'int main() {}'))
    const unregister = registerSemanticMonacoDocument(editor)

    expect(semanticDocumentEditorFor('C:\\repo\\one.cpp')?.model.getValue()).toBe('int main() {}')

    unregister()
    expect(semanticDocumentEditorFor('C:/repo/one.cpp')).toBeNull()
  })

  it('notifies subscribers on register and unregister', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSemanticDocuments(listener)

    const unregister = registerSemanticMonacoDocument(makeEditor(makeModel('mem:two')))
    expect(listener).toHaveBeenCalledTimes(1)

    unregister()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('token idempotency: an old unregister cannot delete a newer registration', () => {
    const uri = toEditorModelUri('C:/repo/three.cpp')
    const first = registerSemanticMonacoDocument(makeEditor(makeModel(uri, 'first')))
    const second = registerSemanticMonacoDocument(makeEditor(makeModel(uri, 'second')))

    first()
    expect(semanticDocumentEditorFor('C:/repo/three.cpp')?.model.getValue()).toBe('second')

    second()
    expect(semanticDocumentEditorFor('C:/repo/three.cpp')).toBeNull()
  })

  it('is a no-op (no notification, safe unregister) when the editor has no model', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSemanticDocuments(listener)

    const unregister = registerSemanticMonacoDocument(makeEditor(null))
    expect(listener).not.toHaveBeenCalled()

    unregister()
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSemanticDocuments(listener)
    unsubscribe()

    const unregister = registerSemanticMonacoDocument(makeEditor(makeModel('mem:four')))
    expect(listener).not.toHaveBeenCalled()
    unregister()
  })
})

describe('semanticDocumentEditorFor', () => {
  it('resolves a file path through toEditorModelUri (same key as the Monaco registry)', () => {
    // Slash form and backslash form of one file must land on the canonical
    // file uri the editor's model is keyed by.
    const uri = toEditorModelUri('D:/proj/Deep/Nested.CPP')
    const editor = makeEditor(makeModel(uri, 'x'))
    const unregister = registerSemanticMonacoDocument(editor)

    expect(semanticDocumentEditorFor('D:\\proj\\Deep\\Nested.CPP')?.editor).toBe(editor)
    expect(semanticDocumentEditorFor('D:/proj/Other.CPP')).toBeNull()

    unregister()
  })

  it('answers null for an unregistered path', () => {
    expect(semanticDocumentEditorFor('Z:/nowhere/absent.cpp')).toBeNull()
  })
})
