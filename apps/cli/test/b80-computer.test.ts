import { afterEach, expect, test } from "bun:test"
import { computerFact, computerSessionCard } from "../src/view/computer-session-card"
import { textWidth } from "../src/view/wrap"
import { b80Harness, B80_SCENES } from "./b80-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)
for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
  test(`B80 session, AX and code transcript frames fit ${width}x${height}`, async () => {
    for (const scene of B80_SCENES) {
      const h = await b80Harness(scene, { width, height })
      try {
        expect(h.frames.at(-1)).toHaveLength(height)
        for (const row of h.text()) { expect(textWidth(row)).toBeLessThanOrEqual(width); expect(row).not.toContain("\x1b") }
        const text = h.text().join("\n")
        expect(text).not.toContain("SECRET")
        // Closed, each card is one row with its fact; its panels are for when it is opened.
        if (scene === "observe-nodes") { expect(text).toMatch(/\d+ nodes/); expect(text).not.toContain("Revision 1") }
        if (scene === "session-control") { expect(text).toContain("· control"); expect(text).not.toContain("Bundle") }
        if (scene === "session-stopped") expect(text).toContain("stopped")
        if (scene === "code-completed") expect(text).toContain("completed · press")
        if (scene === "code-stale") expect(text).toContain("stale")
        if (scene === "code-secure") expect(text).toContain("Secure fields")
        if (scene === "capture-bootstrap") expect(text).toMatch(/Computer capture\s+\d+×\d+/)
      } finally { await h.close() }
    }
  })
}

test("an observation's card reads its text tree, and its closed fact says when nothing changed or no window has focus", () => {
  const base = { revision: 3, target: { pid: 42, bundleID: "local.tray", appName: "Tray" }, truncated: false, observedAt: 1_800_000_000_000, nodeCount: 7 }
  const open = computerSessionCard({ name: "computer_observe", text: JSON.stringify({ ...base, scope: "app", tree: '0.1 Application "Tray" [key]\n  0.2 Window "Settings" {minimized}' }), width: 120, expanded: true, failed: false })!.map((line) => line.map((span) => span.text).join("")).join("\n")
  expect(open).toContain('0.2 Window "Settings" {minimized}')
  expect(open).toContain("app · no window")
  expect(computerFact("computer_observe", JSON.stringify({ ...base, unchanged: true }))).toBe("Tray · 7 nodes · unchanged")
  expect(computerFact("computer_observe", JSON.stringify({ ...base, scope: "app", tree: "" }))).toBe("Tray · 7 nodes · no window")
  expect(computerFact("computer_observe", JSON.stringify({ ...base, nodes: [{}, {}] }))).toBe("Tray · 2 nodes")
})

test("semantic cards use the panel grid and reject malformed data without importing schemas", () => {
  expect(computerSessionCard({ name: "computer_observe", text: "{}", width: 100, expanded: true, failed: false })).toBeUndefined()
  const child = Bun.spawnSync(["bun", "-e", `await import('./apps/cli/src/ui/app'); await import('@mendcode/client'); console.log(Object.keys(require.cache).filter(p => p.includes('/zod/') || p.endsWith('/protocol/src/computer-session.ts')).length)`], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode).toBe(0)
  expect(child.stdout.toString().trim()).toBe("0")
})
