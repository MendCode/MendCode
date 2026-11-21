import { test } from "bun:test"
import { openStore } from "@mendcode/store"
import { createScreen } from "../src/ui/screen"
import { appHarness, tempDir } from "./session-ui-harness"
test("frame cost", async () => {
  const store = openStore({ dir: process.env.PROBE_DB! })
  const sid = "ses_01M7KRWCP2Y5SHF9" as never
  const events: any[] = []
  for (let after = 0; ; ) { const page = store.readAfter(sid, after, 1000); if (!page.length) break; events.push(...page); after = page.at(-1)!.seq }
  const W = 246, H = 66
  let bytes = 0
  const screen = createScreen({ write: (data: string) => void (bytes += data.length), columns: W, rows: H, isTTY: false } as never, { MENDCODE_TERMINAL_TITLE: "0", MENDCODE_MOUSE: "0" })
  screen.enter()
  const h = appHarness({ width: W, height: H, sessionId: sid, dataDir: tempDir("probe-"), screen: screen as never })
  const tail = events.slice(-3000)
  for (const e of tail.slice(0, -400)) h.app.onEvent(e)
  h.app.render()
  // Stream the last 400 events, one frame each, as the live chat would.
  const ms: number[] = []
  bytes = 0
  for (const e of tail.slice(-400)) { h.app.onEvent(e); const s = performance.now(); h.app.render(); ms.push(performance.now() - s) }
  ms.sort((a, b) => a - b)
  console.log(`stream frame p50 ${ms[200]!.toFixed(2)} p95 ${ms[380]!.toFixed(2)} max ${ms[399]!.toFixed(2)} bytes/frame ${(bytes / 400).toFixed(0)}`)
}, 120000)
