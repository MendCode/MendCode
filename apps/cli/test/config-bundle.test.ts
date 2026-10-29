import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const FAKE_KEY = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"

async function machine(label: string, home: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-bundle-${label}-`)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "..", `${path.basename(dir)}-project`)
  mkdirSync(project, { recursive: true })
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: `bundle-${label}` })
  await client.connect()
  cleanups.push(() => client.close())
  const out: string[] = [], err: string[] = []
  const deps: AutomationDeps = { cwd: project, client, listen() {}, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) }, now: () => 1_792_000_000_000, onInterrupt() {}, home, env: {} }
  const run = async (...argv: string[]) => {
    out.length = 0; err.length = 0
    const parsed = parseAutomation(["config-bundle", ...argv])
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    const code = await runAutomation(parsed.command, deps)
    return { code, out: out.join(""), err: err.join(""), json: () => JSON.parse(out.join("")).data as Record<string, any> }
  }
  return { dir, project, daemon, client, run, deps }
}

/** Every file under a folder (links listed, not followed) with its sha256: the before/after picture of a data directory. */
function snapshot(root: string, skip: (relative: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (relative: string) => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name
      if (skip(child)) continue
      const info = statSync(path.join(root, child), { throwIfNoEntry: false })
      if (!info) continue
      if (info.isDirectory()) visit(child)
      else if (info.isFile()) out[child] = createHash("sha256").update(readFileSync(path.join(root, child))).digest("hex")
    }
  }
  visit("")
  return out
}
const config = (relative: string) => /^(mendd\.|d\.sock|blobs|logs|builtin|pr-watch\.json|codegraph|lsp|budget)/.test(relative)

function seedSource(dir: string, home: string) {
  const write = (relative: string, text: string, mode?: number) => { mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true }); writeFileSync(path.join(dir, relative), text, mode ? { mode } : {}) }
  write("skills/review/SKILL.md", `---\nname: review\ndescription: Review helper\n---\nNotes live in ${home}/Notes\n`)
  write("commands/ship.md", "Ship $ARGUMENTS\n")
  write("AGENTS.md", "Global rules from the source\n")
  write("keybindings.json", "{\"ctrl+g\": \"session.new\"}\n")
  write("extensions/footer.ts", "import pad from \"left-pad\"\nexport default { name: \"footer\", tui() { return pad } }\n")
  write("tui/profile.json", "{\"density\":\"compact\",\"tagline\":\"from the mac\",\"copyOnSelect\":true}\n")
  write("tui/helper.sh", "#!/bin/sh\nosascript -e 'beep'\n", 0o755)
  write("mcp.json", JSON.stringify({ servers: { docs: { command: "docs-mcp", args: ["--stdio"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } } } }))
  write("providers.json", JSON.stringify({ openai: { apiKey: FAKE_KEY } }))
  write("environment.enc", "ciphertext")
  write("keys/master.key", "private")
  write("notes/leak.md", `token: ${FAKE_KEY}\n`)
  write("skills/leaky/SKILL.md", `---\nname: leaky\ndescription: x\n---\nOPENAI_API_KEY=${FAKE_KEY}\n`)
  write("packages/looky/mendcode-package.json", JSON.stringify({ name: "looky", version: "1.0.0", description: "look", extensions: false, activate: { tuiProfile: { tagline: "looky" } } }))
  write("packages/looky/skills/hello/SKILL.md", "---\nname: hello\ndescription: hi\n---\nhello\n")
  write("packages/quiet/mendcode-package.json", JSON.stringify({ name: "quiet", version: "0.2.0", description: "q", extensions: false }))
  write("packages/quiet/skills/q/SKILL.md", "---\nname: q\ndescription: q\n---\nq\n")
  write("packages/quiet/skills/r/SKILL.md", "---\nname: r\ndescription: r\n---\nr\n")
  write("packages/runner/mendcode-package.json", JSON.stringify({ name: "runner", version: "0.1.0", description: "r", extensions: false }))
  write("packages/runner/hooks.json", "{\"hooks\":[]}\n")
}

test("export → preview → apply → compare → rollback between two real daemons keeps secrets out, code inert and authority pending", async () => {
  const sourceHome = "/Users/someone"
  const source = await machine("src", sourceHome)
  const target = await machine("dst", "/home/coder")
  seedSource(source.dir, sourceHome)
  source.daemon.store.settings.set({ theme: "mend", promptCacheTtl: "1h", retentionDays: 45, defaultPermission: "full", models: { main: { model: "scripted", effort: "high" } }, disabledPackages: ["user:quiet"], disabledPackageResources: ["user:looky/skills/hello"], trustedToolDirs: ["/Users/someone/Code/x"], provider: { openai: { options: { apiKey: FAKE_KEY } } } })

  // Inventory and export read without changing the source.
  const sourceBefore = snapshot(source.dir, config)
  const inventory = await source.run("inventory", "--json")
  expect(inventory.code).toBe(0)
  const rows = inventory.json().inventory as Array<{ item: string; column: string; exported: boolean }>
  expect(rows.find((row) => row.item === "providers.json")).toMatchObject({ column: "approval", exported: false })
  expect(rows.find((row) => row.item === "packages/runner")).toMatchObject({ column: "approval" })
  const bundleFile = path.join(source.project, "me.mendcode-bundle.json")
  const exported = await source.run("export", bundleFile, "--json")
  expect(exported.code).toBe(0)
  expect(snapshot(source.dir, config)).toEqual(sourceBefore)
  const text = readFileSync(bundleFile, "utf8")
  expect(text).not.toContain(FAKE_KEY)
  expect(text).not.toContain(Buffer.from(FAKE_KEY).toString("base64").slice(0, 24))
  expect(statSync(bundleFile).mode & 0o777).toBe(0o600)
  const summary = exported.json()
  expect(summary.settings).toMatchObject({ applied: expect.arrayContaining(["theme", "promptCacheTtl", "retentionDays"]), approval: expect.arrayContaining(["defaultPermission", "models", "provider"]), machine: ["trustedToolDirs"], withheld: ["provider"] })
  const excluded = (summary.excluded as Array<{ path: string; reason: string }>).map((entry) => entry.path)
  expect(excluded).toEqual(expect.arrayContaining(["providers.json", "environment.enc", "keys", "skills/leaky/SKILL.md", "mendd.db"]))
  expect(await source.run("export", bundleFile)).toMatchObject({ code: 64 })

  // A reviewed false positive can be named explicitly; it is listed as such.
  const reviewed = await source.run("export", path.join(source.project, "reviewed.json"), "--allow-flagged", "skills/leaky", "--json")
  expect((reviewed.json().warnings as string[]).some((line) => line.startsWith("skills/leaky/SKILL.md: flagged as a possible credential"))).toBe(true)

  const inspected = await target.run("inspect", bundleFile, "--json")
  expect(inspected.code).toBe(0)

  // The target already has its own skill, and its AGENTS.md is a link into another repository.
  mkdirSync(path.join(target.dir, "skills/review"), { recursive: true })
  writeFileSync(path.join(target.dir, "skills/review/SKILL.md"), "target's own review\n")
  const elsewhere = path.join(target.project, "shared-AGENTS.md")
  writeFileSync(elsewhere, "linked rules\n")
  symlinkSync(elsewhere, path.join(target.dir, "AGENTS.md"))
  target.daemon.store.settings.set({ theme: "graphite", defaultPermission: "ask" })

  const targetBefore = snapshot(target.dir, config)
  const preview = await target.run("import", bundleFile, "--rewrite-home", "--json")
  expect(preview.code).toBe(0)
  const plan = preview.json().plan
  expect(snapshot(target.dir, config)).toEqual(targetBefore)
  expect(plan.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ item: "skills/review", resolution: "keep" }),
    expect.objectContaining({ item: "AGENTS.md", resolution: "blocked" }),
    expect.objectContaining({ item: "settings.theme", resolution: "keep" }),
  ]))
  expect(plan.warnings.some((line: string) => line.includes("name the source home"))).toBe(false)
  expect(plan.steps.find((step: any) => step.kind === "unit" && step.unit === "skills/review").files[0].rewritten).toBe(true)
  expect(plan.warnings.some((line: string) => line.includes("left-pad"))).toBe(true)
  expect(plan.steps.filter((step: any) => step.kind === "pending").map((step: any) => step.item)).toEqual(expect.arrayContaining(["settings.defaultPermission", "settings.models", "settings.provider", "settings.trustedToolDirs", "tui/profile.json#copyOnSelect"]))

  // Applying needs the previewed plan; a stale id changes nothing.
  expect(await target.run("import", bundleFile, "--rewrite-home", "--apply", "--plan", "0123456789abcdef")).toMatchObject({ code: 1 })
  expect(snapshot(target.dir, config)).toEqual(targetBefore)
  const replacePreview = (await target.run("import", bundleFile, "--rewrite-home", "--resolve", "skills/review=replace", "--json")).json().plan
  const applied = await target.run("import", bundleFile, "--rewrite-home", "--resolve", "skills/review=replace", "--apply", "--plan", replacePreview.planId.slice(0, 16), "--json")
  expect(applied.code).toBe(0)
  const result = applied.json()
  expect(result.report.identical).toBe(false)
  expect(result.report.summary).toContain("not identical")

  // Written: resources (home folder rewritten), packages through the installer with their state, preferences.
  expect(readFileSync(path.join(target.dir, "skills/review/SKILL.md"), "utf8")).toContain("/home/coder/Notes")
  expect(readFileSync(path.join(target.dir, "commands/ship.md"), "utf8")).toBe("Ship $ARGUMENTS\n")
  expect(readFileSync(elsewhere, "utf8")).toBe("linked rules\n")
  const settings = target.daemon.store.settings.get()
  expect(settings.theme).toBe("graphite")
  expect(settings.promptCacheTtl).toBe("1h")
  expect(settings.retentionDays).toBe(45)
  expect(settings.defaultPermission).toBe("ask")
  expect(settings.models).toBeUndefined()
  expect(settings.disabledPackages).toEqual(["user:quiet"])
  expect(settings.disabledPackageResources).toEqual(["user:looky/skills/hello"])
  expect(existsSync(path.join(target.dir, "packages/looky/skills/hello/SKILL.md"))).toBe(true)
  expect(existsSync(path.join(target.dir, "packages/runner"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(target.dir, "tui/profile.json"), "utf8"))).toEqual({ density: "compact", tagline: "from the mac" })

  // Inert: code and scripts only in quarantine; the MCP server waits for approval.
  expect(existsSync(path.join(target.dir, "extensions"))).toBe(false)
  expect(existsSync(path.join(result.quarantineFolder, "extensions/footer.ts"))).toBe(true)
  expect(existsSync(path.join(result.quarantineFolder, "packages/runner/hooks.json"))).toBe(true)
  expect(existsSync(path.join(result.quarantineFolder, "tui/helper.sh"))).toBe(true)
  const docs = JSON.parse(readFileSync(path.join(target.dir, "mcp.json"), "utf8")).servers.docs
  expect(docs).toMatchObject({ enabled: false, pendingApproval: { enabled: true } })
  const pending = JSON.parse(readFileSync(result.pendingFile, "utf8"))
  expect(JSON.stringify(pending)).not.toContain(FAKE_KEY)
  expect(pending.items.map((item: { item: string }) => item.item)).toContain("settings.defaultPermission")

  const rowsAfter = result.report.rows as Array<{ item: string; status: string }>
  expect(rowsAfter.find((row) => row.item === "skills/review")).toMatchObject({ status: "match" })
  expect(rowsAfter.find((row) => row.item === "settings.theme")).toMatchObject({ status: "kept-target" })
  expect(rowsAfter.find((row) => row.item === "AGENTS.md")).toMatchObject({ status: "blocked" })
  expect(rowsAfter.find((row) => row.item === "packages/quiet")).toMatchObject({ status: "match" })
  expect(rowsAfter.find((row) => row.item === "providers.json")).toMatchObject({ status: "omitted" })

  // Rollback skips what was changed by hand since the import, then --force undoes it too.
  writeFileSync(path.join(target.dir, "commands/ship.md"), "edited after import\n")
  const careful = await target.run("rollback", result.importId, "--json")
  expect(careful.code).toBe(1)
  expect(careful.json().skipped.some((line: string) => line.startsWith("commands/ship.md"))).toBe(true)
  const forced = await target.run("rollback", result.importId, "--force", "--json")
  expect(forced.code).toBe(0)
  const after = target.daemon.store.settings.get()
  expect(after.promptCacheTtl).toBeUndefined()
  expect(after.retentionDays).toBeUndefined()
  expect(after.disabledPackages).toBeUndefined()
  expect(after.disabledPackageResources).toBeUndefined()
  expect(readFileSync(path.join(target.dir, "skills/review/SKILL.md"), "utf8")).toBe("target's own review\n")
  expect(existsSync(path.join(target.dir, "commands/ship.md"))).toBe(false)
  expect(existsSync(path.join(target.dir, "packages/looky"))).toBe(false)
  expect(existsSync(path.join(target.dir, "tui/profile.json"))).toBe(false)
  expect(existsSync(path.join(target.dir, "mcp.json"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(target.dir, "mcp-pending-budget.json"), "utf8"))).toEqual({})
  const restored = snapshot(target.dir, (relative) => config(relative) || relative.startsWith("config-imports") || relative.startsWith(".Trash") || relative === "activation.json" || relative === "mcp-pending-budget.json")
  expect(restored).toEqual(Object.fromEntries(Object.entries(targetBefore).filter(([relative]) => relative !== "activation.json")))
  expect((await target.run("imports", "--json")).json().imports[0]).toMatchObject({ importId: result.importId, state: "rolled-back" })
}, 60_000)

test("a session cannot apply or roll back an import, and remote attachments cannot use bundle files", async () => {
  const target = await machine("guard", "/home/coder")
  const bundleFile = path.join(target.project, "b.json")
  const source = await machine("guard-src", "/home/coder")
  writeFileSync(path.join(source.dir, "AGENTS.md"), "rules\n")
  expect((await source.run("export", bundleFile)).code).toBe(0)
  const preview = (await target.run("import", bundleFile, "--json")).json().plan
  target.deps.env = { MENDCODE_AGENT_SHELL: target.dir }
  const refused = await target.run("import", bundleFile, "--apply", "--plan", preview.planId.slice(0, 16))
  expect(refused.code).toBe(1)
  expect(refused.err).toContain("a session cannot apply")
  expect(existsSync(path.join(target.dir, "AGENTS.md"))).toBe(false)
  target.deps.env = {}
  target.deps.allowFiles = false
  expect((await target.run("inventory")).code).toBe(64)
}, 30_000)

test("config-bundle arguments: commands, conflict options and refusals", () => {
  const parse = (...argv: string[]) => parseAutomation(["--dir", "/tmp/d", "config-bundle", ...argv])
  expect(parse("inventory", "--json")).toMatchObject({ ok: true, command: { kind: "config-bundle.inventory", dir: "/tmp/d", json: true } })
  expect(parse("export", "out.json", "--allow-flagged", "packages/seda", "--allow-flagged", "skills/x", "--overwrite")).toMatchObject({ ok: true, command: { kind: "config-bundle.export", file: "out.json", allowFlagged: ["packages/seda", "skills/x"], overwrite: true } })
  expect(parse("import", "b.json", "--on-conflict", "replace", "--resolve", "settings.theme=keep", "--resolve", "tui/profile.json#density=replace", "--rewrite-home")).toMatchObject({ ok: true, command: { kind: "config-bundle.import", apply: false, onConflict: "replace", resolve: { "settings.theme": "keep", "tui/profile.json#density": "replace" }, rewriteHome: true } })
  expect(parse("import", "b.json", "--apply", "--plan", "0123456789abcdef")).toMatchObject({ ok: true, command: { apply: true, plan: "0123456789abcdef" } })
  expect(parse("rollback", "imp-abc-123456", "--force")).toMatchObject({ ok: true, command: { kind: "config-bundle.rollback", importId: "imp-abc-123456", force: true } })
  for (const argv of [["import", "b.json", "--apply"], ["import", "b.json", "--plan", "0123456789abcdef"], ["import", "b.json", "--on-conflict", "merge"], ["import", "b.json", "--resolve", "x"], ["export"], ["export", "a", "--rewrite-home"], ["rollback"], ["inventory", "extra"], ["nope"]]) expect(parse(...argv)).toMatchObject({ ok: false })
})
