import type { Route, WorkflowsRoute } from "./route"

// Keep the monitor's original caller across a detour into a task transcript.
// The task session is not a new owner of the monitor's back navigation.
export function preserveWorkflowReturn(current: Route, next: Route): Route {
  if (current.type === "workflows" && next.type === "session") {
    const monitor: WorkflowsRoute = {
      type: "workflows",
      selectedID: current.selectedID,
      returnTo: current.returnTo,
    }
    return { ...next, workflowReturnTo: monitor }
  }
  if (current.type === "session" && next.type === "workflows" && current.workflowReturnTo) {
    return {
      ...next,
      selectedID: next.selectedID ?? current.workflowReturnTo.selectedID,
      returnTo: current.workflowReturnTo.returnTo,
    }
  }
  return next
}
