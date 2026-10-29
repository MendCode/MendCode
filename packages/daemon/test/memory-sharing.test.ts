import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type MemoryEntry, type MemoryId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createMemorySharing } from "../src/memory-sharing"
import { createMemoryWorkspaces } from "../src/memory-workspaces"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const ids = createIdFactory()
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b08-memory-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function boot() {
  const dir = temp()
  const store = openStore({ dir })
  let closed = false
  const close = () => { if (!closed) { store.close(); closed = true } }
  cleanups.push(close)
  const changed: MemoryId[] = []
  const profile = (directory?: string) => directory === "/other-profile" ? "work" : "personal"
  const sharing = createMemorySharing({ dir, store, profile, id: () => ids("memory"), changed: (id) => changed.push(id) })
  const add = (text = "Run bun test", patch: Partial<MemoryEntry> = {}) => {
    const memoryId = ids("memory")
    store.memories.add({ memoryId, scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "user", ...patch })
    return memoryId
  }
  const enable = (scope: "project" | "user" = "project", root = "/repo") => sharing.configure(scope, root, true, `ENABLE ${scope.toUpperCase()}`)
  const edit = (directory: string, id: MemoryId, text: string) => {
    const file = path.join(directory, `${id}.md`)
    const header = readFileSync(file, "utf8").split("\n")[0]
    writeFileSync(file, `${header}\n\n${text}\n`)
    return file
  }
  return { dir, store, close, sharing, changed, add, enable, edit, workspaces: createMemoryWorkspaces({ store, profile }) }
}

test("sharing is off without IO; enabling requires exact scope consent and disabling retains files", async () => {
  const h = boot()
  const status = await h.sharing.status("project", "/repo")
  expect(status.enabled).toBe(false)
  expect(existsSync(path.join(h.dir, "memory-sharing"))).toBe(false)
  await expect(h.sharing.configure("project", "/repo", true, "ENABLE USER")).rejects.toThrow("ENABLE PROJECT")
  expect(existsSync(path.join(h.dir, "memory-sharing"))).toBe(false)
  await expect(h.sharing.run("project", "/repo", "export")).rejects.toThrow("disabled")
  await h.enable()
  const id = h.add()
  const result = await h.sharing.run("project", "/repo", "export")
  expect(result.exported).toEqual([id])
  expect((await h.sharing.configure("project", "/repo", false)).enabled).toBe(false)
  expect(existsSync(path.join(result.directory, `${id}.md`))).toBe(true)
  await expect(h.sharing.run("project", "/repo", "import")).rejects.toThrow("disabled")
})

test("export isolates projects/profiles and skips pending, archived, session and sensitive memories", async () => {
  const h = boot()
  const saved = h.add()
  const secret = h.add("API_KEY=AbCdeF1234567890")
  const security = h.add("Vault recovery phrase", { category: "security" })
  h.add("Pending fact", { status: "pending" })
  h.add("Archived fact", { status: "archived" })
  h.add("Other project", { directory: "/other" })
  h.add("Session plan", { scope: "session", sessionId: ids("session") })
  const user = h.add("Personal preference", { scope: "user", directory: undefined })
  h.add("Work preference", { scope: "user", directory: undefined, profile: "work" })
  await h.enable()
  const result = await h.sharing.run("project", "/repo", "export")
  expect(result.exported).toEqual([saved])
  expect(result.skipped.map((item) => item.id).sort()).toEqual([secret, security].sort())
  await h.enable("user")
  const personal = await h.sharing.run("user", "/repo", "export")
  expect(personal.exported).toEqual([user])
  expect(personal.directory).not.toBe(result.directory)
  expect((await h.sharing.status("user", "/other-profile")).enabled).toBe(false)
})

test("import is a durable deduplicated revision; approval preserves ids, pins and graph links", async () => {
  const h = boot()
  const id = h.add("Use npm", { pinned: true })
  const other = h.add("Run checks")
  h.store.memories.link({ from: id, to: other, kind: "related" })
  await h.enable()
  const exported = await h.sharing.run("project", "/repo", "export")
  h.edit(exported.directory, id, "Use pnpm")
  const first = await h.sharing.run("project", "/repo", "import")
  const second = await h.sharing.run("project", "/repo", "import")
  expect(first.proposals).toHaveLength(1)
  expect(second.proposals).toEqual(first.proposals)
  expect(h.changed).toEqual(first.proposals)
  const proposal = first.proposals[0]!
  expect(h.store.memories.get(id)?.text).toBe("Use npm")
  expect(h.store.memories.get(proposal)).toMatchObject({ status: "pending", source: "user", kind: "update", targetId: id, text: "Use pnpm" })
  expect(h.store.memories.resolveRevision(proposal, true).result).toBe("applied")
  expect(h.store.memories.get(id)).toMatchObject({ text: "Use pnpm", pinned: true })
  expect(h.store.memories.links([id, other])).toHaveLength(1)
  // Only an exact accepted projection may replace the edited file on the next export.
  expect((await h.sharing.run("project", "/repo", "export")).conflicts).toEqual([])
  expect((await h.sharing.run("project", "/repo", "import")).proposals).toEqual([])
})

test("stale imports and stale approvals never overwrite a newer internal revision", async () => {
  const h = boot()
  const id = h.add()
  await h.enable()
  const exported = await h.sharing.run("project", "/repo", "export")
  h.edit(exported.directory, id, "Run focused tests")
  const imported = await h.sharing.run("project", "/repo", "import")
  h.store.memories.update(id, { text: "Run all checks" })
  expect(h.store.memories.resolveRevision(imported.proposals[0]!, true).result).toBe("stale")
  expect(h.store.memories.get(id)?.text).toBe("Run all checks")
  const again = await h.sharing.run("project", "/repo", "import")
  expect(again.proposals).toEqual([])
  expect(again.conflicts).toMatchObject([{ id, reason: "Internal revision changed" }])
  expect((await h.sharing.run("project", "/repo", "export")).conflicts).toMatchObject([{ id, reason: "Markdown has external edits" }])
})

test("metadata tampering, secrets, empty edits, oversized files and symlinks are visible conflicts", async () => {
  const h = boot()
  const ids = Array.from({ length: 6 }, (_, i) => h.add(`Rule ${i}`))
  await h.enable()
  const exported = await h.sharing.run("project", "/repo", "export")
  const file = (id: MemoryId) => path.join(exported.directory, `${id}.md`)
  const tampered = readFileSync(file(ids[0]!), "utf8").replace('"version":2', '"version":1')
  writeFileSync(file(ids[0]!), tampered)
  h.edit(exported.directory, ids[1]!, "API_KEY=AbCdeF1234567890")
  h.edit(exported.directory, ids[2]!, "")
  writeFileSync(file(ids[3]!), "a".repeat(40_000))
  rmSync(file(ids[4]!))
  const outside = path.join(h.dir, "outside.md")
  writeFileSync(outside, "outside")
  symlinkSync(outside, file(ids[4]!))
  h.edit(exported.directory, ids[5]!, "a".repeat(2_001))
  const result = await h.sharing.run("project", "/repo", "import")
  expect(result.proposals).toEqual([])
  expect(result.conflicts.map((item) => item.id).sort()).toEqual(ids.sort())
  expect(readFileSync(outside, "utf8")).toBe("outside")
})

test("external index edits and deleted snapshots are preserved without deleting memory", async () => {
  const h = boot()
  const id = h.add()
  await h.enable()
  const exported = await h.sharing.run("project", "/repo", "export")
  const index = path.join(exported.directory, "index.md")
  writeFileSync(index, "My index")
  rmSync(path.join(exported.directory, `${id}.md`))
  expect((await h.sharing.run("project", "/repo", "import")).proposals).toEqual([])
  expect(h.store.memories.get(id)).toBeDefined()
  expect((await h.sharing.run("project", "/repo", "export")).conflicts).toMatchObject([{ id: "index.md" }])
  expect(readFileSync(index, "utf8")).toBe("My index")
})

test("scope metadata cannot be copied to another project's tracked snapshot", async () => {
  const h = boot()
  const a = h.add("First project")
  const b = h.add("Second project", { directory: "/other" })
  await h.enable()
  await h.enable("project", "/other")
  const first = await h.sharing.run("project", "/repo", "export")
  const second = await h.sharing.run("project", "/other", "export")
  writeFileSync(path.join(second.directory, `${b}.md`), readFileSync(path.join(first.directory, `${a}.md`), "utf8"))
  expect((await h.sharing.run("project", "/other", "import")).conflicts).toMatchObject([{ id: b, reason: "Metadata or origin changed" }])
})

test("a linked sharing directory is refused, and a corrupt inventory is never reset", async () => {
  const h = boot()
  const outside = temp()
  symlinkSync(outside, path.join(h.dir, "memory-sharing"))
  await expect(h.sharing.status("project", "/repo")).rejects.toThrow("link")
  await expect(h.enable()).rejects.toThrow("link")
  expect(existsSync(path.join(outside, "state.json"))).toBe(false)
  rmSync(path.join(h.dir, "memory-sharing"))
  const status = await h.enable()
  const file = path.join(status.directory, "state.json")
  writeFileSync(file, "bad JSON")
  await expect(h.sharing.status("project", "/repo")).rejects.toThrow()
  await expect(h.sharing.configure("project", "/repo", false)).rejects.toThrow()
  expect(readFileSync(file, "utf8")).toBe("bad JSON")
})

test("sharing consent and review deduplication survive store reopen; parallel exports serialize", async () => {
  const h = boot()
  const id = h.add()
  await h.enable()
  const [one, two] = await Promise.all([h.sharing.run("project", "/repo", "export"), h.sharing.run("project", "/repo", "export")])
  expect(one.conflicts).toEqual([])
  expect(two.conflicts).toEqual([])
  h.edit(one.directory, id, "Run pnpm test")
  const imported = await h.sharing.run("project", "/repo", "import")
  h.close()
  const store = openStore({ dir: h.dir })
  cleanups.push(() => store.close())
  const sharing = createMemorySharing({ dir: h.dir, store, profile: () => "personal", id: () => ids("memory"), changed() {} })
  expect((await sharing.status("project", "/repo")).enabled).toBe(true)
  expect((await sharing.run("project", "/repo", "import")).proposals).toEqual(imported.proposals)
})

test("inventory cap refuses over 200 entries without writing projections", async () => {
  const h = boot()
  for (let i = 0; i < 201; i++) h.add(`Rule ${i}`)
  const status = await h.enable()
  await expect(h.sharing.run("project", "/repo", "export")).rejects.toThrow("200")
  expect(existsSync(path.join(status.directory, "index.md"))).toBe(false)
})

test("workspace discovery uses persisted memory/session origins; browsing all keeps profile boundaries", () => {
  const h = boot()
  h.add("Current project")
  h.add("Older project", { directory: "/older", source: "agent", status: "pending" })
  h.add("Private work", { directory: "/other-profile" })
  h.add("Personal preference", { scope: "user", directory: undefined })
  h.add("Private preference", { scope: "user", directory: undefined, profile: "work" })
  h.store.createSession({ id: ids("session"), directory: "/history", title: "History" })
  const report = h.workspaces.list("/repo")
  expect(report.workspaces.map((item) => item.root).sort()).toEqual(["/repo", "/older", "/history"].sort())
  expect(report.workspaces.find((item) => item.root === "/older")).toMatchObject({ source: "imported-root", pending: 1, agent: 1 })
  expect(report.workspaces.find((item) => item.root === "/history")).toMatchObject({ source: "historical-session", sessions: 1 })
  expect(h.workspaces.browse("/repo", "all").memories.map((item) => item.text).sort()).toEqual(["Current project", "Older project", "Personal preference"].sort())
  expect(h.workspaces.browse("/repo", "user").memories.map((item) => item.text)).toEqual(["Personal preference"])
  expect(() => h.workspaces.browse("/repo", "project", "/other-profile")).toThrow("another profile")
})
