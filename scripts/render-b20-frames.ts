import { writeFileSync } from "node:fs"
import path from "node:path"
import type { Loop } from "@mendcode/protocol"
import { boot, answer } from "../packages/daemon/test/native-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { editorRows } from "../apps/cli/src/view/editor"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { Line } from "../apps/cli/src/ui/theme"

/** Real CLI runner and native daemon, fake model and temporary data; monitor frames use its draw boundary. */
export async function renderB20Frames(directory: string, sizes: string[]) {
  const h = await boot({ steps: [answer("```LOOP_CHECKPOINT\nstatus: continue\nsummary: local checks inspected\n```", { input: 10, output: 5 })] })
  try {
    const reports = new Map<string, string>()
    const run = async (name: string, args: string[], extra: Partial<AutomationDeps> = {}, expected = 0) => {
      const parsed = parseAutomation(args)
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let text = ""
      const deps: AutomationDeps = { client: h.client, cwd: h.project, now: Date.now, listen() {}, onInterrupt() {}, isTTY: false, out: { write: (value) => { text += value } }, err: { write: (value) => { text += value } }, ...extra }
      const code = await runAutomation(parsed.command, deps)
      if (code !== expected) throw new Error(`${name} exited ${code}: ${text}`)
      if (!name.endsWith("-capture")) reports.set(name, text)
      return text
    }
    await run("status-empty", ["loops", "status"])
    await run("examples", ["loops", "examples"])
    await run("templates", ["control-plane", "loops", "templates"])
    const draftOutput = await run("draft", ["loops", "draft", "--name", "CI Watch", "--objective", "Inspect local checks and report failing tests", "--json"])
    const loop = JSON.parse(draftOutput).data.loop as Loop
    const draft = await h.client.loopSnapshot(loop.loopId)
    if (!draft.ok) throw new Error(draft.error.message)
    await run("status-draft", ["loops", "status"])
    await run("show-draft", ["loops", "show", loop.loopId])
    await run("tick-draft", ["loops", "tick", loop.loopId])
    await run("activate", ["loops", "activate", loop.loopId, "--reason", "Inspect local checks", "--no-service"])
    const active = await h.client.loopSnapshot(loop.loopId)
    if (!active.ok) throw new Error(active.error.message)
    await run("status-active", ["loops", "status"])
    await run("tick-dry-run", ["loops", "tick", loop.loopId])
    await run("tick-no-due", ["loops", "tick"])
    await run("tick-execute", ["loops", "tick", loop.loopId, "--execute"])
    await run("show", ["loops", "show", loop.loopId])
    await run("tail", ["loops", "tail", loop.loopId])
    await run("tail-json", ["loops", "tail", loop.loopId, "--json", "--limit", "2"])
    await run("monitor-text", ["loops", "monitor", loop.loopId, "--once"])
    await run("show-missing", ["loops", "show", "loop_missing"], {}, 1)
    const finished = await h.client.loopSnapshot(loop.loopId)
    if (!finished.ok) throw new Error(finished.error.message)
    const normalizeIds = (text: string) => text.replace(/\b(?:ses|lop)_[0-9A-HJKMNP-TV-Z]{26}\b/g, (id) => `${id.slice(0, 4)}${"0".repeat(26)}`)
    const normalize = (text: string) => normalizeIds(text.split(h.project).join("/tmp/b20-project").split(h.dir).join("/tmp/b20-data"))
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: Line[]) => {
        const plain = rows.map((row) => fit([{ text: normalizeIds(row.map((span) => span.text).join("")) }], width).map((span) => span.text).join(""))
        if (plain.length !== height || plain.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`Invalid frame: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), plain.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = editorRows(normalize(output.trimEnd()), width).map((row): Line => [{ text: row.text }])
        for (let page = 0; page * height < Math.max(1, rows.length); page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => rows[page * height + row] ?? []))
      }
      for (const [state, snapshot] of [["draft", draft.snapshot], ["active", active.snapshot], ["checkpoint", finished.snapshot]] as const) {
        let frame: Line[] | undefined
        // Run the same monitor app entry and daemon reply through a captured screen, never call the view directly.
        await run(`monitor-${state}-capture`, ["loops", "monitor", loop.loopId, "--once"], {
          isTTY: true, terminalSize: { width, height }, drawLoopFrame: (rows) => { frame = rows },
          client: { ...h.client, send: async () => ({ ok: true, result: snapshot as unknown as Record<string, unknown> }) },
        })
        if (!frame) throw new Error("Monitor did not draw")
        save(`monitor-${state}`, frame)
      }
    }
  } finally { await h.cleanup() }
}
