import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import type { CommandReply } from "@mendcode/client"
import { createCacheControl } from "../packages/daemon/src/cache"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB49Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-b49-frames-"))), store = openStore({ dir })
  try {
    const cache = createCacheControl(store), reports = new Map<string, string>()
    for (const [name, args] of [
      ["cache-status-legacy", ["status"]],
      ["cache-enable-project", ["enable", "--scope", "project"]],
      ["cache-provider-model", ["enable", "--global", "--provider", "openai", "--model", "exact", "--scope", "project"]],
      ["cache-excluded-session", ["disable", "--session", "ses_excluded"]],
      ["cache-status-off-session", ["status", "--session", "ses_excluded"]],
      ["cache-disable-global", ["disable", "--global"]],
    ] as const) {
      const command = parseAutomation(["cache", ...args])
      if (command.ok !== true) throw new Error(JSON.stringify(command))
      let output = ""
      const deps: AutomationDeps = { cwd: "/work/mendcode", client: { send: async (request) => {
        const report = request.type === "cache.status" ? cache.status(request) : request.type === "cache.set" ? cache.set(request.input).report : undefined
        if (!report) throw new Error(`unexpected command ${request.type}`)
        return { ok: true, result: report } as CommandReply
      }, subscribe: async () => ({ ok: true }) }, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } }, listen: () => {}, now: () => 0, onInterrupt: () => {} }
      if (await runAutomation(command.command, deps) !== 0) throw new Error(output)
      reports.set(name, output)
    }
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      for (const [name, output] of reports) {
        const lines = wrap(output.trimEnd(), width)
        for (let page = 0; page * height < lines.length; page++) {
          const rows = Array.from({ length: height }, (_, row) => fit([{ text: lines[page * height + row] ?? "" }], width).map((span) => span.text).join(""))
          if (rows.some((row) => textWidth(row) !== width || /[\x00-\x1f]/.test(row))) throw new Error(`invalid frame ${name} ${size}`)
          writeFileSync(path.join(directory, `${name}${lines.length > height ? `-p${page + 1}` : ""}-${size}.txt`), rows.join("\n") + "\n")
        }
      }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}
