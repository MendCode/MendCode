import { afterEach, expect, test } from "bun:test"
import type { CompoundReport } from "@mendcode/protocol"
import { b24Report } from "../../../scripts/b24-fixture"
import { renderCompoundPage } from "../src/view/compound-page"
import { SLASH_COMMANDS, takesArguments } from "../src/view/commands"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)
function harness(state: Parameters<typeof b24Report>[0] = "accepted", remote = false) {
  let report = b24Report(state)
  const h = appHarness({ width: 100, height: 30, dataDir: tempDir(), directory: "/work/mendcode", ...(remote ? { remote: { host: "127.0.0.1", readOnly: true } } : {}), reply: (command) => {
    if (command.type === "compound.configure") report = { ...report, config: command.config }
    return { ok: true, ...(command.type === "compound.get" || command.type === "compound.configure" ? { result: { report } } : {}) }
  } })
  h.app.applySettings({ onboarded: true })
  return h
}
test("compound is discoverable and Tab completes without dispatching", async () => {
  const h = harness()
  expect(takesArguments(SLASH_COMMANDS.find((command) => command.name === "compound")!)).toBe(true)
  await h.type("/compound\t")
  expect(h.sentOf("compound.get")).toHaveLength(0)
  expect(h.sentOf("compound.start")).toHaveLength(0)
  await h.app.onKey("\r")
  expect(h.sentOf("compound.get")).toHaveLength(1)
  expect(h.text().join("\n")).toContain("Compound")
})
test("factory controls configure CAS, refresh and cancel; hints remain in header", async () => {
  const h = harness("running")
  await h.type("/compound\r")
  expect(h.text()[0]).toContain("r refresh")
  await h.app.onKey("e")
  expect(h.sentOf("compound.configure")[0]).toMatchObject({ expectedHash: "a".repeat(64), config: { orchestration: { enabled: false } } })
  await h.app.onKey("x")
  expect(h.sentOf("compound.cancel")).toHaveLength(1)
  await h.app.onKey("r")
  expect(h.sentOf("compound.get").length).toBeGreaterThan(2)
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).not.toContain("┌─ Ledger")
})
test("compound run sends explicit checks and project identity", async () => {
  const h = harness()
  await h.type('/compound run critic {"prompt":"repair parser","checks":[{"id":"diff","command":"git diff --check"}]}\r')
  expect(h.sentOf("compound.start")).toEqual([{ type: "compound.start", input: { directory: "/work/mendcode", profile: "critic", prompt: "repair parser", permission: "ask", originSessionId: h.sessionId, checks: [{ id: "diff", command: "git diff --check" }] } }])
  await h.app.onKey("\x1b")
  await h.type("/compound run critic bad-json\r")
  expect(h.sentOf("compound.start")).toHaveLength(1)
})
test("read-only terminals cannot configure, run or cancel", async () => {
  const h = harness("running", true)
  await h.type("/compound\r")
  await h.app.onKey("e")
  await h.app.onKey("x")
  expect(h.sentOf("compound.configure")).toHaveLength(0)
  expect(h.sentOf("compound.cancel")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("Read-only terminal")
})
test("opening a compound leg reuses the actual saved session", async () => {
  const h = harness()
  await h.type("/compound\r")
  await h.app.onKey("o")
  expect(h.subscriptions.some((entry) => entry.sessionId === b24Report().runs[0]!.legs.at(-1)!.sessionId)).toBe(true)
})
test("every compound state fits compact and wide grids and pages scroll", () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    for (const state of ["off", "running", "accepted", "blocked", "unreviewed-revision"] as const) {
      const report = b24Report(state)
      const page = { profile: 2, run: 0, scroll: 0, error: "" }
      const frame = renderCompoundPage({ report, state: page, width: width!, height: height!, readOnly: false })
      expect(frame).toHaveLength(height!)
      expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) === width)).toBe(true)
      expect(frame.map((line) => line.map((span) => span.text).join("")).join("\n")).not.toContain("allow-with-to ")
      if (width! < 70) {
        page.scroll = 15
        const later = renderCompoundPage({ report, state: page, width: width!, height: height!, readOnly: false }).flatMap((line) => line.map((span) => span.text)).join("")
        expect(later).not.toEqual(frame.flatMap((line) => line.map((span) => span.text)).join(""))
      }
    }
  }
})
test("unknown USD is visibly unknown and final revisions are explicitly unreviewed", () => {
  const render = (report: CompoundReport) => renderCompoundPage({ report, state: { profile: 2, run: 0, scroll: 0, error: "" }, width: 180, height: 50, readOnly: false }).flatMap((line) => line.map((span) => span.text)).join("")
  expect(render(b24Report("accepted"))).toContain("+ unknown")
  expect(render(b24Report("unreviewed-revision"))).toContain("not independently reviewed again")
})
test("compound stays lazy and its startup and page graphs remain schema-free", () => {
  const script = `await import("./apps/cli/src/ui/app"); await import("@mendcode/client");
const has = () => Object.keys(require.cache).some((key) => key.endsWith("/view/compound-page.ts"));
const eager = has(); const { preload } = await import("./apps/cli/src/ui/lazy-pages"); await preload("compound");
console.log(JSON.stringify({eager,loaded:has(),zod:Object.keys(require.cache).some((key)=>key.includes("/zod/"))}))`
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({ eager: false, loaded: true, zod: false })
})
