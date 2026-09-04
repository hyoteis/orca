import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import { createSshCppSetupHost } from './code-intelligence-cpp-setup-ssh-host'
import { runCppSetupPipeline } from './code-intelligence-cpp-setup-pipeline'

type Dependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

/** Thin shell over the shared setup pipeline: assembles the SSH Host adapter. */
export class CodeIntelligenceSshCppSetup {
  constructor(
    private readonly store: Store,
    private readonly dependencies: Dependencies
  ) {}

  run(request: CodeIntelligenceCppSetupRequest): Promise<CodeIntelligenceCppSetupResult> {
    return runCppSetupPipeline(this.store, createSshCppSetupHost(this.dependencies), request)
  }
}
