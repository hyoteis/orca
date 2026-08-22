import {
  normalizeCodeIntelligenceScope,
  type CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'

type CodeIntelligenceScopePersistence = {
  upsert: (scope: CodeIntelligenceScope) => Promise<CodeIntelligenceScope>
  remove: (scopeId: string) => Promise<boolean>
}

export class CodeIntelligenceScopeCatalog {
  private scopes: CodeIntelligenceScope[]
  private readonly listeners = new Set<(scopeId: string) => void>()
  constructor(
    initial: readonly CodeIntelligenceScope[],
    private readonly persistence: CodeIntelligenceScopePersistence
  ) {
    this.scopes = initial.map(normalizeCodeIntelligenceScope)
  }
  list(): readonly CodeIntelligenceScope[] {
    return this.scopes.map((scope) => structuredClone(scope))
  }
  async upsert(input: CodeIntelligenceScope): Promise<void> {
    const normalized = normalizeCodeIntelligenceScope(input)
    const prior = this.scopes.find((scope) => scope.id === normalized.id)
    const persisted = normalizeCodeIntelligenceScope(await this.persistence.upsert(normalized))
    const index = this.scopes.findIndex((scope) => scope.id === persisted.id)
    if (index !== -1) {
      this.scopes[index] = persisted
    } else {
      this.scopes.push(persisted)
    }
    if (prior && prior.revision !== persisted.revision) {
      for (const listener of this.listeners) {
        listener(persisted.id)
      }
    }
  }
  async remove(scopeId: string): Promise<void> {
    if (!(await this.persistence.remove(scopeId))) {
      return
    }
    this.scopes = this.scopes.filter((scope) => scope.id !== scopeId)
    for (const listener of this.listeners) {
      listener(scopeId)
    }
  }
  subscribeRestart(listener: (scopeId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
