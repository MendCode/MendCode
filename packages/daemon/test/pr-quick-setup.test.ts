import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { previewQuickSetup } from "../src/pr-review/quick-setup"
import type { GitRun } from "../src/pr-review/context"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(options: { config?: string; missing?: boolean; origin?: string; logout?: boolean; ready?: boolean; public?: boolean; tier?: "balanced" | "minimalist" } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "quick-setup-")); dirs.push(dataDir)
  const calls: string[] = []
  const git: GitRun = async (args) => {
    const key = args.join(" "); calls.push(key)
    if (key === "config --get remote.origin.url") return { code: 0, out: options.origin ?? "https://github.com/acme/private.git" }
    if (key === "config --get remote.public.url" && options.public) return { code: 0, out: "https://github.com/acme/public.git" }
    if (args[0] === "symbolic-ref") return { code: 0, out: "origin/main" }
    if (key === "show origin/main:.mendcode/review.yaml" && !options.missing) return { code: 0, out: options.config ?? "enabled: true\n" }
    return { code: 1, out: "" }
  }
  const gh = async (args: string[]) => { calls.push(args.join(" ")); return { code: options.logout ? 1 : 0, out: args[0] === "api" ? "enabled: true\n" : "" } }
  if (options.ready) {
    mkdirSync(path.join(dataDir, "pr-review"))
    writeFileSync(path.join(dataDir, "pr-review/watches.json"), JSON.stringify({ watches: [{ directory: "/project", repo: "acme/private", role: "all", publish: "allowed" }] }))
  }
  return { calls, input: { directory: "/project", dataDir, settings: { tier: options.tier ?? "balanced", experimental: { pr_review: options.ready ?? false } }, git, gh } }
}
test("scratch preview lists every change and no unrelated network checks", async () => {
  const h = fixture(); const report = await previewQuickSetup(h.input)
  expect(report.problems).toEqual([]); expect(report.changes).toHaveLength(3); expect(report.role).toBe("all")
  expect(h.calls.filter((call) => call.startsWith("auth") || call.startsWith("api"))).toEqual(["auth status"])
  expect(report.text).toContain("GitHub using your gh login")
})
test("already configured is a no-op; personal config and explicit role are respected", async () => {
  const ready = await previewQuickSetup(fixture({ ready: true }).input)
  expect(ready.changes).toEqual([]); expect(ready.skipped).toHaveLength(3)
  const h = fixture({ config: "enabled: true\nreviewers: requested\n" })
  expect((await previewQuickSetup(h.input)).role).toBe("requested")
  expect((await previewQuickSetup({ ...h.input, role: "all" })).role).toBe("all")
})
test("logged-out, wrong origin, forbidden tier and missing base config are actionable", async () => {
  for (const [options, text] of [[{ logout: true }, "gh auth login"], [{ origin: "/local/repo" }, "Origin is not"], [{ tier: "minimalist" }, "balanced tier"], [{ missing: true }, "Commit it there"]] as const) {
    expect((await previewQuickSetup(fixture(options).input)).problems.join("\n")).toContain(text)
  }
})
test("public remote is detected without changing git state; digest binds the preview", async () => {
  const h = fixture({ missing: true, public: true })
  const report = await previewQuickSetup(h.input)
  expect(report.publicRepo).toBe("acme/public"); expect(report.text).toContain("No remote has been changed")
  expect(h.calls.some((call) => /set-url|fetch|checkout/.test(call))).toBe(false)
  const a = fixture(); const first = await previewQuickSetup(a.input)
  expect((await previewQuickSetup(a.input)).digest).toBe(first.digest)
  expect((await previewQuickSetup({ ...a.input, role: "requested" })).digest).not.toBe(first.digest)
})
