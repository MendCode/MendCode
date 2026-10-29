import { runScriptBody, type CallReply } from "./script-runtime"
import type { ScriptHostPort } from "./script-engine"

/**
 * A script host that runs the script in the caller's own process. It is NOT isolated (the script shares the process's globals,
 * only the lexical names are shadowed): it exists for tests of the orchestration, where the point is call ordering, journaling and
 * resume, not containment. The daemon never uses it; the isolated process host is `packages/daemon/src/workflow-script-host.ts`.
 */
export function createInProcessScriptHost(): ScriptHostPort & { started: number; killed: string[] } {
  const port = {
    started: 0,
    killed: [] as string[],
    start(input: Parameters<ScriptHostPort["start"]>[0]) {
      port.started++
      let dead = false
      const pending = new Map<number, (reply: CallReply) => void>()
      void Promise.resolve().then(async () => {
        try {
          const result = await runScriptBody({
            body: input.body,
            meta: input.meta,
            args: input.args,
            seed: input.seed,
            now: input.now,
            transport: {
              call: (message) =>
                new Promise<CallReply>((resolve) => {
                  pending.set(message.id as number, resolve)
                  queueMicrotask(() => !dead && input.onMessage({ t: "call", ...JSON.parse(JSON.stringify(message)) }))
                }),
              post: (message) => queueMicrotask(() => !dead && input.onMessage(JSON.parse(JSON.stringify(message)))),
            },
          })
          if (!dead) input.onMessage({ t: "done", ...(result !== undefined ? { result: JSON.parse(JSON.stringify(result)) } : {}) })
        } catch (error) {
          if (!dead) input.onMessage({ t: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
        }
      })
      return {
        send(message: Record<string, unknown>) {
          if (dead || message.t !== "reply") return
          const resolve = pending.get(message.id as number)
          pending.delete(message.id as number)
          resolve?.(message.ok ? { ok: true, value: message.value, at: Number(message.at) } : { ok: false, error: String(message.error), at: Number(message.at) })
        },
        kill(reason: string) {
          dead = true
          port.killed.push(reason)
          // A killed script is abandoned: its pending calls never resolve and it is garbage collected.
          pending.clear()
        },
      }
    },
  }
  return port
}
