import { getLoopTemplate, type CreateLoopInput, type LoopService } from "@mendcode/loops"
import type { Command, Loop, LoopSnapshot } from "@mendcode/protocol"
import { redactValue } from "./secrets"

type Control = Extract<Command, { type: "loop.draft" | "loop.snapshot" | "loop.events" | "loop.activate" | "loop.tick" }>
type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; code: "invalid_command" | "target_mismatch" | "busy"; message: string }

/** These reports contain user text; keep them full-access and redact historical secrets before sending. */
const safe = redactValue

export function createLoopControl(options: {
  service: LoopService
  now(): number
  create(input: CreateLoopInput): Promise<{ ok: true; loop: Loop } | { ok: false; message: string }>
  children(sessionId: Loop["sessionId"]): LoopSnapshot["children"]
}) {
  const missing = (): Reply => ({ ok: false, code: "target_mismatch", message: "[DAEMON]: unknown loop in this project" })
  return async (command: Control): Promise<Reply> => {
    const { service } = options
    if (command.type === "loop.draft") {
      const template = getLoopTemplate(command.template)
      const created = await options.create({
        name: command.name ?? template?.name ?? "",
        directory: command.directory,
        ...(command.objective ? { objective: command.objective } : {}),
        ...(command.template ? { template: command.template } : {}),
        ...(command.trigger ? { trigger: command.trigger } : template ? {} : { trigger: { kind: "manual" as const } }),
        ...(command.budget ? { budget: command.budget } : template ? {} : { budget: { mode: "monitor" as const } }),
        ...(command.reportOnly !== undefined ? { reportOnly: command.reportOnly } : {}),
        draft: true,
      })
      return created.ok ? { ok: true, result: { loop: safe(created.loop) } } : { ok: false, code: "invalid_command", message: `[DAEMON]: ${created.message}` }
    }
    if (command.type === "loop.tick") {
      if (command.loopId && service.get(command.loopId)?.directory !== command.directory) return missing()
      const results = await service.tick(command)
      return { ok: true, result: { results: safe(results) } }
    }
    const loop = service.get(command.loopId)
    if (!loop) return missing()
    if (command.type === "loop.activate") {
      const active = service.activate(loop.loopId, command.reason)!
      return { ok: true, result: { loop: safe(active), service: { kind: "integrated" } } }
    }
    const events = loop.journal ?? []
    if (command.type === "loop.events") return { ok: true, result: { events: safe(events.slice(-command.limit)) } }
    const snapshot: LoopSnapshot = {
      loop,
      events: events.slice(-50),
      children: options.children(loop.sessionId),
      scheduler: { kind: "integrated", ...(loop.nextWakeAt !== undefined ? { nextWakeAt: loop.nextWakeAt } : {}), overdue: loop.state === "active" && loop.nextWakeAt !== undefined && loop.nextWakeAt <= options.now() },
    }
    return { ok: true, result: safe(snapshot) }
  }
}
