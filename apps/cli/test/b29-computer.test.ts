import { afterEach, expect, test } from "bun:test"
import { computerCard } from "../src/view/computer-card"
import { textWidth } from "../src/view/wrap"
import { b29Harness, B29_SCENES } from "./b29-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
  test(`B29 real tool results and error cards stay within ${width}x${height}`, async () => {
    for (const scene of ["capture-main", "key-pressed", "key-focus-changed"] as const) {
      const h = await b29Harness(scene, { width, height })
      try {
        const text = h.text().join("\n")
        expect(h.frames.at(-1)).toHaveLength(height)
        expect(text).toContain(scene === "capture-main" ? "Computer capture" : "Computer key")
        expect(text).toContain(scene === "capture-main" ? "800×500" : scene === "key-pressed" ? "pressed tab" : "Foreground application changed")
        expect(h.text().some((row) => row.includes("›") || row.includes("❯"))).toBe(true)
        // A result is one row until opened; a failure keeps its panel, so what went wrong is read at once.
        if (scene === "key-focus-changed" && width >= 100) expect(text).toContain("┌─ Computer key")
        else expect(text).not.toContain("┌─ Computer")
        for (const row of h.text()) { expect(textWidth(row)).toBeLessThanOrEqual(width); expect(row).not.toContain("\x1b") }
      } finally { await h.close() }
    }
  })
}

test("B29 capture states, one-key recovery and Ctrl+O details use truthful transcript copy", async () => {
  for (const scene of B29_SCENES.filter((scene) => scene !== "capture-approval")) {
    const h = await b29Harness(scene, { width: 180, height: 50 })
    try {
      const text = h.text().join("\n")
      expect(text).not.toContain('"keyboardControlAvailable"')
      expect(text).not.toContain('"captureID"')
      if (scene === "capture-expanded") { expect(text).toContain("SHA-256"); expect(text).toContain("Preview pixels") }
      if (scene === "capture-unchanged") expect(text).toContain("· unchanged")
      if (["capture-window", "capture-region", "capture-multiple-displays"].includes(scene)) expect(text).toContain("no keyboard")
      if (scene === "capture-disabled") expect(text).toContain("MENDCODE_COMPUTER=1")
      if (scene === "key-consumed" || scene === "key-stale") expect(text).toContain("missing or stale")
    } finally { await h.close() }
  }
})

test("new computer cards leave malformed data to the normal tool renderer", () => {
  for (const text of ["null", "{}", "not JSON", '{"captureID":"x","width":1}']) expect(computerCard({ name: "computer_capture", text, width: 96, expanded: true, failed: false })).toBeUndefined()
  expect(computerCard({ name: "read", text: "{}", width: 96, expanded: false, failed: false })).toBeUndefined()
})

test("computer cards and client helpers do not load protocol schemas or zod into CLI startup", () => {
  const child = Bun.spawnSync(["bun", "-e", `await import("./apps/cli/src/ui/app"); await import("@mendcode/client"); const files = Object.keys(require.cache); console.log(JSON.stringify({ zod: files.filter((file) => file.includes("/zod/")).length, computer: files.filter((file) => file.endsWith("/protocol/src/computer.ts")).length }))`], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode).toBe(0)
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual({ zod: 0, computer: 0 })
})
