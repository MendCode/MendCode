import type { TraceSample } from "@mendcode/protocol"
import type { AppContext } from "./context"

/** Observe render cost and geometry only; rows and keystrokes never leave the renderer. */
export function createTrace(ctx: AppContext) {
  return {
    frame(render: () => void) {
      if (!ctx.input.trace) return render()
      const started = performance.now()
      let status: TraceSample["status"] = "ok"
      try { render() } catch (error) { status = "error"; throw error }
      finally {
        try { ctx.input.trace({ name: "tui.frame", metadata: { sessionId: ctx.state.sessionId, cols: ctx.input.screen.size.width, rows: ctx.input.screen.size.height }, durationMs: Math.max(0, performance.now() - started), status }) } catch {}
      }
    },
  }
}
