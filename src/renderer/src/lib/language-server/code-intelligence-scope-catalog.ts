import {
  normalizeCodeIntelligenceScope,
  scopeConfigurationPayload,
  type CodeIntelligenceScope
} from '../../../../shared/code-intelligence-scope'
export class CodeIntelligenceScopeCatalog {
  private scopes: CodeIntelligenceScope[]
  private readonly listeners = new Set<(scopeId: string) => void>()
  constructor(
    initial: readonly CodeIntelligenceScope[],
    private readonly persist: (scopes: readonly CodeIntelligenceScope[]) => void | Promise<void>
  ) {
    this.scopes = initial.map(normalizeCodeIntelligenceScope)
  }
  list(): readonly CodeIntelligenceScope[] {
    return this.scopes.map((scope) => structuredClone(scope))
  }
  async upsert(next: CodeIntelligenceScope): Promise<void> {
    let normalized = normalizeCodeIntelligenceScope(next)
    const index = this.scopes.findIndex((scope) => scope.id === normalized.id)
    const prior = index >= 0 ? this.scopes[index] : null
    const changed = prior
      ? JSON.stringify(scopeConfigurationPayload(prior)) !==
        JSON.stringify(scopeConfigurationPayload(normalized))
      : true
    if (prior && changed) {
      normalized = { ...normalized, consent: undefined }
    }
    if (index >= 0) {
      this.scopes[index] = normalized
    } else {
      this.scopes.push(normalized)
    }
    await this.persist(this.list())
    if (prior && changed) {
      for (const listener of this.listeners) {
        listener(normalized.id)
      }
    }
  }
  async remove(scopeId: string): Promise<void> {
    const next = this.scopes.filter((scope) => scope.id !== scopeId)
    if (next.length === this.scopes.length) return
    this.scopes = next
    await this.persist(this.list())
    for (const listener of this.listeners) listener(scopeId)
  }
  subscribeRestart(listener: (scopeId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
