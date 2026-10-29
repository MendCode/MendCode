import type { Command, LedgerExport, LedgerPage, LedgerQuery } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

export type LedgerCommand = Extract<Command, { type: "workflow.events" | "workflow.artifacts" | "workflow.receipt" | "workflow.export" | "loop.events" | "loop.artifacts" | "loop.receipt" | "loop.export" }>

function exportPage(page: LedgerPage, format: LedgerExport["format"]): LedgerExport {
  const { entries, ...metadata } = page
  const text = format === "json" ? JSON.stringify({ schema: "mendcode.automation-ledger.v1", ...page }, null, 2) : [
    `# ${page.scope} ${page.ownerId}`,
    `Retained: ${page.retained} · History: ${page.historical ? "recorded" : "snapshot only"} · Truncated: ${page.truncated}`,
    ...(page.nextBefore ? [`Next cursor: ${page.nextBefore}`] : []),
    ...entries.flatMap((entry) => ["", `## #${entry.sequence} · Run ${entry.run} · ${entry.kind}`, entry.title, entry.summary, "", "````json", JSON.stringify(entry.data, null, 2), "````"]),
  ].join("\n")
  return { format, text, page: metadata }
}

export function createAutomationLedgerHost(store: Store) {
  return {
    handle(command: LedgerCommand) {
      const scope = "workflowId" in command ? "workflow" : "loop"
      const owner = "workflowId" in command ? command.workflowId : command.loopId
      if (!store.automationLedger.known(scope, owner)) return { ok: false as const, code: "target_mismatch" as const, message: `[LEDGER]: unknown ${scope}` }
      const operation = command.type.split(".")[1]
      const category = operation === "events" ? "event" : operation === "artifacts" ? "artifact" : operation === "receipt" ? "receipt" : undefined
      const query: LedgerQuery = { ...(command.run !== undefined ? { run: command.run } : {}), ...(command.before ? { before: command.before } : {}), limit: command.limit ?? (operation === "receipt" ? 1 : 50) }
      const page = store.automationLedger.page(scope, owner, category, query)
      return { ok: true as const, result: operation === "export" ? { export: exportPage(page, "format" in command ? command.format ?? "json" : "json") } : { ledger: page } }
    },
  }
}
