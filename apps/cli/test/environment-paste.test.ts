import { expect, test } from "bun:test"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { looksLikeDotenv, pasteSummary, renderEnvironmentPage, type EnvironmentPageState } from "../src/view/environment-page"
import { createIdFactory } from "@mendcode/protocol"

const ids = createIdFactory({ now: () => 1_700_000_000_000, random: (size) => new Uint8Array(size).fill(1) })
const PASTE = "export FAKE_TOKEN=abc123-fake\nOTHER_KEY='second fake'\n# note\nPATH=/fake/bin\nEMPTY=\nOTHER_KEY=third-fake"

function harness() {
  const frames: Line[][] = [], sent: Record<string, unknown>[] = []
  const app = createApp({ sessionId: ids("session"), directory: "/project", mode: "balanced", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}),
    screen: { size: { width: 100, height: 30 }, draw: (rows: Line[]) => frames.push(rows) } as never,
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      if (command.type === "privacy.get") return { ok: true, result: { enabled: false } }
      if (command.type === "env.import" && typeof command.content === "string") {
        // Stand-in for the daemon: names and statuses only.
        const names = [...new Set([...String(command.content).matchAll(/^(?:export\s+)?([A-Z_]+)=(.*)$/gm)].map((match) => match[1]!))]
        const items = names.map((name) => ({ name, status: name === "PATH" ? "refused" : name === "EMPTY" ? "empty" : "new", ...(name === "PATH" ? { reason: "runtime configuration name" } : {}) }))
        return { ok: true, result: { names: names.filter((name) => name !== "PATH" && name !== "EMPTY"), items, digest: "a".repeat(64), entries: [] } }
      }
      if (String(command.type).startsWith("env.")) return { ok: true, result: { entries: [], native: true } }
      return { ok: true }
    }) as never,
  })
  const text = () => frames.slice(-1).flat().map((line) => line.map((span) => span.text).join("")).join("\n")
  const key = async (value: string) => { await app.onKey(value); await Bun.sleep(2) }
  const paste = async (value: string) => { await app.onInput(`\x1b[200~${value}\x1b[201~`); await Bun.sleep(2) }
  const open = async () => { await app.onInput("/env"); await key("\r") }
  const imports = () => sent.filter((command) => command.type === "env.import")
  return { app, sent, text, key, paste, open, imports }
}

test("pasting a .env on the list shows detected names with counts, never values", async () => {
  const h = harness()
  await h.open(); await h.paste(PASTE)
  const frame = h.text()
  expect(frame).toContain("4 found · 2 new · 1 refused (PATH) · 1 empty")
  expect(frame).toContain("[x] FAKE_TOKEN")
  expect(frame).toContain("[x] OTHER_KEY")
  expect(frame).toContain("[-] PATH")
  for (const secret of ["abc123-fake", "second fake", "third-fake", "/fake/bin"]) expect(frame).not.toContain(secret)
  expect(h.sent.some((command) => command.type === "user.submit" || command.type === "prompt.record")).toBe(false)
})

test("space and a choose a subset; Enter saves only the selected names with the digest", async () => {
  const h = harness()
  await h.open(); await h.paste(PASTE)
  await h.key("a")
  expect(h.text()).toContain("[ ] FAKE_TOKEN")
  await h.key("a")
  await h.key(" ")
  expect(h.text()).toContain("[ ] FAKE_TOKEN")
  await h.key("\r")
  expect(h.imports().at(-1)).toMatchObject({ content: PASTE, scope: "project", digest: "a".repeat(64), names: ["OTHER_KEY"] })
  expect(h.text()).toContain("Saved 1 variable to project scope")
  expect(h.text()).not.toContain("abc123-fake")
})

test("Enter with nothing selected saves nothing; Esc drops the pasted text", async () => {
  const h = harness()
  await h.open(); await h.paste(PASTE)
  await h.key("a"); await h.key("\r")
  expect(h.imports().some((command) => command.digest)).toBe(false)
  expect(h.text()).toContain("Select at least one variable")
  await h.key("\x1b")
  expect(h.app.page).toBe("env")
  expect(h.text()).not.toContain("Detected variables")
  await h.key("\r")
  expect(h.imports().some((command) => command.digest)).toBe(false)
})

test("a NAME=value line pasted into the value field offers detection instead of becoming the value", async () => {
  const h = harness()
  await h.open(); await h.key("a"); await h.key("MY_KEY"); await h.key("\r")
  await h.paste("OTHER_KEY=fake-inline-value")
  expect(h.text()).toContain("Detected variables")
  expect(h.text()).toContain("[x] OTHER_KEY")
  expect(h.text()).not.toContain("fake-inline-value")
  expect(h.sent.some((command) => command.type === "env.set")).toBe(false)
  await h.key("\r")
  expect(h.imports().at(-1)).toMatchObject({ names: ["OTHER_KEY"] })
})

test("a plain secret pasted into the value field is still one hidden value", async () => {
  const h = harness()
  await h.open(); await h.key("a"); await h.key("MY_KEY"); await h.key("\r")
  await h.paste("sk-fake-plain-value==")
  expect(h.text()).not.toContain("Detected variables")
  await h.key("\r")
  expect(h.sent).toContainEqual({ type: "env.set", sessionId: h.app.sessionId, name: "MY_KEY", value: "sk-fake-plain-value==", scope: "project" })
})

test("the detection list is plain text with ASCII checkboxes and fits a narrow screen", () => {
  const items = [{ name: "FAKE_TOKEN", status: "replace" as const }, { name: "DUP", status: "new" as const, duplicates: 1 }, { name: "PATH", status: "refused" as const, reason: "runtime configuration name" }]
  const state: EnvironmentPageState = { entries: [], selected: 0, loading: false, busy: false, error: "", scope: "project", paste: { content: "x", items, digest: "d", checked: new Set(["DUP"]), cursor: 1 } }
  const rows = renderEnvironmentPage(state, 60, 24, { glyphs: glyphs({ MENDCODE_GLYPHS: "ascii" }) }).map((line) => line.map((span) => span.text).join(""))
  const frame = rows.join("\n")
  expect(frame).toContain("3 found · 1 new · 1 replaces · 1 refused (PATH)")
  expect(frame).toContain("[ ] FAKE_TOKEN")
  expect(frame).toContain("[x] DUP")
  expect(frame).toContain("defined 2x, last wins")
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(60)
  expect(pasteSummary(items)).toBe("3 found · 1 new · 1 replaces · 1 refused (PATH)")
  expect(looksLikeDotenv("abc==")).toBe(false)
  expect(looksLikeDotenv("# c\nexport A_B = 1")).toBe(true)
  expect(looksLikeDotenv("-----BEGIN KEY-----\nA=\n")).toBe(false)
})

const SECRET = "sk-fake-9f8e7d6c5b4a3210zyxwvu"

test("a value pasted into the name field never draws and moves to the masked value field", async () => {
  const h = harness()
  await h.open(); await h.key("a"); await h.paste(SECRET)
  expect(h.text()).not.toContain(SECRET)
  expect(h.text()).not.toContain("sk-fake")
  expect(h.text()).toContain("•••••••• (set)")
  await h.key("\t")
  await h.key("\t")
  expect(h.text()).not.toContain("sk-fake")
})

test("a value pasted on the list opens the add form with the value masked", async () => {
  const h = harness()
  await h.open(); await h.paste(SECRET)
  expect(h.text()).not.toContain("sk-fake")
  expect(h.text()).toContain("•••••••• (set)")
  expect(h.sent.some((command) => command.type === "env.set" || command.type === "user.submit" || command.type === "prompt.record")).toBe(false)
})

test("a value pasted in the value field is masked and saved only on Enter", async () => {
  const h = harness()
  await h.open(); await h.key("a")
  for (const char of "MY_KEY") await h.key(char)
  await h.key("\r"); await h.paste(`${SECRET}\nline2`)
  expect(h.text()).not.toContain("sk-fake")
  await h.key("\r")
  expect(h.sent.filter((command) => command.type === "env.set").at(-1)).toMatchObject({ name: "MY_KEY", value: `${SECRET}\nline2` })
})

test("the name field refuses characters a name cannot hold", async () => {
  const h = harness()
  await h.open(); await h.key("a"); await h.key("-"); await h.key("k")
  expect(h.text()).not.toContain("-k")
})

test("Caps Lock: capital shortcuts work on the list, and capitals still type into the form", async () => {
  const h = harness()
  await h.open(); await h.key("A")
  expect(h.text()).toContain("Credential")
  for (const char of "API_KEY") await h.key(char)
  expect(h.text()).toContain("API_KEY")
  await h.key("\x1b"); await h.key("Q")
  expect(h.text()).not.toContain("Environment & privacy")
})
