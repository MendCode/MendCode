import { rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b28Harness } from "../apps/cli/test/b28-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB28Frames(directory: string, sizes: string[]) {
  const cases: Array<{ screen: string; name: Parameters<typeof b28Harness>[0]; input: Parameters<typeof b28Harness>[1]; options?: Parameters<typeof b28Harness>[2]; expanded?: boolean }> = [
    { screen: "session-search", name: "session_search", input: { query: "linked" } },
    { screen: "session-read", name: "session_read", input: {} },
    { screen: "session-read-page", name: "session_read", input: {}, options: { empty: true } },
    { screen: "session-notes-read", name: "session_notes", input: { action: "read" } },
    { screen: "session-notes-write", name: "session_notes", input: { action: "write", version: 1, text: "Decision: keep recall opt-in.\nNext: verify isolation and revisions." } },
    { screen: "session-notes-revision", name: "session_notes", input: { action: "read", version: 0 } },
    { screen: "session-notes-conflict", name: "session_notes", input: { action: "write", version: 0, text: "Stale revision" } },
    { screen: "session-recall-disabled", name: "session_read", input: {}, options: { disabled: true } },
    { screen: "session-recall-child", name: "session_read", input: {}, options: { child: true } },
    { screen: "session-search-empty", name: "session_search", input: { query: "not in history" } },
    { screen: "session-notes-long", name: "session_notes", input: { action: "read" }, options: { long: true } },
    { screen: "session-notes-expanded", name: "session_notes", input: { action: "write", version: 1, text: "Decision: keep recall opt-in.\nScope: current session and linked children.\nProject: every ancestor must match.\nHistory: retain pre-compaction events.\nReasoning: never return private reasoning.\nTools: include successful output only.\nPaging: follow older-page cursors.\nNotes: use the latest version before writing.\nRevisions: retain earlier versions.\nPermissions: reads remain available in plan mode.\nWrites: require normal write authority.\nScratchpad: keep private project notes separate." }, expanded: true },
  ]
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    for (const scenario of cases) {
      const harness = await b28Harness(scenario.name, scenario.input, { width, height, ...scenario.options })
      try {
        if (scenario.expanded) await harness.type("\x0f")
        const frame = harness.frames.at(-1) ?? []
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${scenario.screen} ${size}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${scenario.screen}`)
        writeFileSync(path.join(directory, `${scenario.screen}-${size}.txt`), `${rows.join("\n")}\n`)
      } finally {
        await harness.type("\x03")
        harness.history.store.close()
        rmSync(harness.history.dir, { recursive: true, force: true })
      }
    }
  }
}
