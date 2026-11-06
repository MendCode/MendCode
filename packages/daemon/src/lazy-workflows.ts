import type { WorkflowPort } from "@mendcode/tools"
import type { createWorkflowsHost, WorkflowsHost } from "./workflows"

/** Keep even the host out of startup; observers and engine routing must not cause a load. */
export function lazyWorkflows(options: Parameters<typeof createWorkflowsHost>[0]): WorkflowsHost {
  let host: WorkflowsHost | undefined
  let loading: Promise<WorkflowsHost> | undefined
  let disposed = false
  const load = () => loading ??= import("./workflows").then(({ createWorkflowsHost }) => {
    host = createWorkflowsHost(options)
    if (disposed) host.dispose()
    return host
  })
  return {
    boot() { if (options.store.hasLive()) void load().then((host) => { if (!disposed) host.boot() }) },
    loaded: () => host?.loaded() ?? false,
    execution: (sessionId) => host?.execution(sessionId),
    recordUsage: (sessionId, event) => host?.recordUsage(sessionId, event),
    observe: (event) => host?.observe(event),
    handle: async (...args) => (await load()).handle(...args),
    port(sessionId, directory): WorkflowPort {
      const port = async () => (await load()).port(sessionId, directory)
      return {
        preview: async (...args) => (await port()).preview(...args),
        start: async (...args) => (await port()).start(...args),
        status: async (...args) => (await port()).status(...args),
        previewControl: async (...args) => (await port()).previewControl!(...args),
        save: async (...args) => (await port()).save!(...args),
        ledger: async (...args) => (await port()).ledger!(...args),
        control: async (...args) => (await port()).control!(...args),
      }
    },
    dispose() { disposed = true; host?.dispose() },
  }
}
