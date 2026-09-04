import type { Store } from '../persistence'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import type { CppSetupCommandRunner } from './code-intelligence-cpp-setup-tools'
import { createLocalCppSetupHost } from './code-intelligence-cpp-setup-local-host'
import { runCppSetupPipeline } from './code-intelligence-cpp-setup-pipeline'

type SetupDependencies = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  run?: CppSetupCommandRunner
}

/** Thin shell over the shared setup pipeline: assembles the local Host adapter. */
export class CodeIntelligenceCppSetup {
  constructor(
    private readonly store: Store,
    private readonly cacheRoot: string,
    private readonly dependencies: SetupDependencies = {}
  ) {}

  run(request: CodeIntelligenceCppSetupRequest): Promise<CodeIntelligenceCppSetupResult> {
    const host = createLocalCppSetupHost({
      ...this.dependencies,
      cacheRoot: this.cacheRoot
    })
    return runCppSetupPipeline(this.store, host, request)
  }
}
