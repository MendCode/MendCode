import type { HistoryTurn, ModelChoice, ModelsReport, SkillsReport } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export const parityModels: ModelsReport = { engine: "native", selectable: true, models: [
  { id: "local:atlas", name: "Atlas", provider: "local", efforts: ["low", "high"], contextWindow: 128_000, variants: { precise: { effort: "high", parameters: { temperature: 0, text: { verbosity: "low" } } }, fast: { effort: "low", parameters: { max_output_tokens: 512 } } } },
  { id: "second:swift", name: "Swift", provider: "second", efforts: [] },
], defaults: { model: "local:atlas" }, effective: { model: "local:atlas" }, roles: {} }
export function parityHarness(options: HarnessOptions = {}) {
  const sessionId = options.sessionId ?? ids("session")
  let report: ModelsReport = structuredClone(parityModels)
  const skills: SkillsReport = { skills: [
    { name: "review", description: "Review callers and error paths", source: "project", dir: "/work/mendcode/.mendcode/skills/review", enabled: true },
    { name: "release", description: "Check artifacts before release", source: "user", dir: "/work/skills/release", enabled: true },
  ] }
  const turns: HistoryTurn[] = Array.from({ length: 45 }, (_, i) => ({ turnId: ids("turn"), at: NOW - (45 - i) * 60_000, seq: i * 10 + 1, preview: `Prompt ${i + 1}: inspect the session reader`, outcome: "completed", items: [
    { itemId: ids("item"), kind: "user_message", text: `Prompt ${i + 1}: inspect the session reader`, status: "ok" },
    { itemId: ids("item"), kind: "tool_call", tool: "task", title: "reviewer", text: i === 2 ? "Needle in the subagent output" : "Read callers and tests", status: "ok" },
    { itemId: ids("item"), kind: "agent_message", text: `## Answer ${i + 1}\n\nThe reader preserves **complete turns**.\n\n${Array.from({ length: 40 }, (_, line) => `Evidence row ${line + 1}`).join("\n\n")}\n\nFinal evidence`, status: "ok" },
  ] }))
  const h = appHarness({ ...options, sessionId, dataDir: options.dataDir ?? tempDir(), directory: options.directory ?? "/work/mendcode", reply: (command) => {
    const custom = options.reply?.(command)
    if (custom) return custom
    if (command.type === "session.timeline") return { ok: true, result: { entries: [] } }
    if (command.type === "session.history") {
      const eligible = turns.filter((t) => command.turnId ? t.turnId === command.turnId : (command.before === undefined || t.seq < command.before) && (command.after === undefined || t.seq > command.after))
      const page = command.after !== undefined ? eligible.slice(0, command.limit ?? 20) : eligible.slice(-(command.limit ?? 20))
      const first = page[0]?.seq
      const last = page.at(-1)?.seq
      return { ok: true, result: { turns: page, ...(first !== undefined && first > 1 ? { older: first } : {}), ...(last !== undefined && last < turns.at(-1)!.seq ? { newer: last } : {}) } }
    }
    if (command.type === "models.list") return { ok: true, result: report }
    if (command.type === "session.model.set") {
      const choice = command.choice as ModelChoice | null
      const model = report.models.find((m) => m.id === choice?.model)
      const variant = choice?.variant ? model?.variants?.[choice.variant] : undefined
      report = { ...report, ...(choice ? { session: choice } : { session: undefined }), effective: choice ? { ...choice, ...variant } : report.defaults }
      return { ok: true, result: report }
    }
    if (command.type === "skills.list") return { ok: true, result: skills }
    if (command.type === "skills.set") {
      const skill = skills.skills.find((s) => s.name === command.name)!
      skill.enabled = command.enabled
      return { ok: true, result: skills }
    }
    if (command.type === "skills.load") return skills.skills.find((s) => s.name === command.name)?.enabled ? { ok: true, result: { body: "Read callers before changes.\nRun focused checks." } } : { ok: false, error: { code: "invalid_command", message: "Skill disabled" } }
    if (command.type === "session.list") return { ok: true, result: { sessions: [{ sessionId, directory: "/work/mendcode", title: "History parity", createdAt: NOW - 60_000, updatedAt: NOW, state: "idle" }] } }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, turns, skills }
}
