import { cmd } from "./cmd"
import { withSharedClient } from "../shared-client"
import { contextReport } from "@/session/context-profile"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"

export const ContextCommand = cmd({
  command: "context <sessionID>",
  describe: "inspect recent context estimates, cache usage and request timing",
  builder: (yargs) => yargs
    .positional("sessionID", { type: "string", demandOption: true })
    .option("limit", { type: "number", default: 20, describe: "recent messages to inspect (1–100)" })
    .option("json", { type: "boolean", default: false, describe: "print the structured context report" }),
  handler: async (args) => {
    const id = SessionID.make(args.sessionID)
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new Error("limit must be an integer from 1 to 100")
    const report = await withSharedClient(process.cwd(), async (connection) => {
      const url = new URL(`/session/${encodeURIComponent(id)}/message`, connection.url)
      url.searchParams.set("limit", String(args.limit))
      url.searchParams.set("view", "tui")
      url.searchParams.set("partsLimit", "100")
      const response = await fetch(url, { headers: connection.headers, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Context report failed (HTTP ${response.status})`)
      return contextReport(await response.json() as MessageV2.WithParts[])
    })
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log("Context and cache — recent messages")
    if (!report.requests.length) {
      console.log("No request profiles in this page. Profiles are recorded by the updated runtime on completed steps.")
      return
    }
    for (const request of report.requests) {
      const p = request.profile
      const t = p.estimatedTokens
      console.log(`\n${request.messageID}  ${request.providerID}/${request.modelID}`)
      console.log(`Estimated tokens: instructions ${t.instructions}, memory ${t.memory}, history ${t.history}, tool results ${t.toolResults}, schemas ${t.toolSchemas}, media ${t.media}; total ${t.total}`)
      console.log(`Provider input: ${request.inputTokens ?? "unavailable"}; cache read: ${request.cachedTokens ?? "unavailable"}; cache write: ${request.cacheWriteTokens ?? "unavailable"}; hit rate: ${request.cacheHitRate === null ? "unavailable" : `${(request.cacheHitRate * 100).toFixed(1)}%`}`)
      console.log(`First token: ${p.firstTokenMs == null ? "unavailable" : `${p.firstTokenMs} ms`}; request: ${p.durationMs ?? "unavailable"} ms; tools: ${p.toolCount}; images: ${p.imageCount}`)
    }
  },
})
