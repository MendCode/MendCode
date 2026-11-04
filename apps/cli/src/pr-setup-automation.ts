import type { SessionId } from "@mendcode/protocol"
import type { AutomationDeps, Common } from "./automation"
import type { PrSetupAutomation } from "./github-args"

export async function runPrSetup(command: PrSetupAutomation & Common, deps: AutomationDeps): Promise<number> {
  const emit = (data: Record<string, unknown>, text: string) => deps.out.write(command.json ? `${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: command.kind, data })}\n` : `${text}\n`)
  if (deps.allowFiles === false) { emit({ error: "local only" }, "PR setup requires a local daemon."); return 64 }
  const base = { type: "pr.review" as const, sessionId: command.session as SessionId, ...(command.role ? { role: command.role } : {}) }
  const preview = await deps.client.send({ ...base, action: "setup-preview" })
  if (!preview.ok) { emit({ error: preview.error.message }, preview.error.message); return 1 }
  const setup = preview.result?.setup as { text: string; digest: string; changes: string[]; problems: string[] } | undefined
  if (!setup) { emit({ error: "unsupported" }, "The daemon does not support PR setup."); return 1 }
  if (setup.problems.length || !setup.changes.length) { emit({ setup, applied: false }, setup.problems.length ? `${setup.text}\n\nNothing changed: fix what needs attention above, then run this again.` : setup.text); return setup.problems.length ? 1 : 0 }
  if (!command.json) deps.out.write(`${setup.text}\n`)
  const yes = command.yes || (!command.json && deps.prompt && await deps.prompt({ title: "PR setup", label: "Apply these changes, including GitHub publishing?", options: [{ value: "yes", label: "Apply setup" }, { value: "no", label: "Cancel" }] }) === "yes")
  if (!yes) { emit({ setup, applied: false }, "Nothing changed. Use --yes to consent to the listed changes, including GitHub publishing."); return 4 }
  const applied = await deps.client.send({ ...base, action: "setup-apply", reason: setup.digest })
  emit(applied.ok ? applied.result ?? {} : { error: applied.error.message }, applied.ok ? String(applied.result?.text ?? "Setup complete") : applied.error.message)
  return applied.ok ? 0 : 1
}
