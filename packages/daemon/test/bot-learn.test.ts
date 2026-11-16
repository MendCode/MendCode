import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BOT_SKILLS_PROMPT_MAX, botSkillsPrompt, createBotPort, listBotSkills } from "../src/bot-learn"
import { OVERVIEW_MAX_CHARS, workspaceOverview } from "../src/bot-recall"
import { describeTrigger, nextWake, parseTrigger } from "../../loops/src/schedule"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "bot-learn-")); dirs.push(dir); return dir }
const port = (dir: string, name = "calm") => createBotPort({ dir, name, directory: "/work/app", sessionId: "ses_x", redact: (text) => text.replace(/sk-[a-z0-9]+/g, "[secret]"), loops: { list: () => [], stop: () => undefined, create: async () => ({ ok: false, message: "no loops" }) } })

describe("weekly triggers", () => {
  test("weekly mon 09:00 is a daily trigger on Monday; the text form round-trips", () => {
    const trigger = parseTrigger("weekly mon 09:00")
    expect(trigger).toEqual({ kind: "daily", at: "09:00", days: [1] })
    expect(describeTrigger(trigger!)).toBe("weekly mon 09:00")
    expect(parseTrigger("weekly mon,thu 18:30 Europe/Madrid")).toEqual({ kind: "daily", at: "18:30", days: [1, 4], timezone: "Europe/Madrid" })
    expect(parseTrigger("weekly someday 09:00")).toBeUndefined()
    expect(parseTrigger("daily 09:00")).toEqual({ kind: "daily", at: "09:00" })
  })

  test("the next wake is the next Monday, in a zone and without one", () => {
    // 2026-11-15 is a Sunday; the next Monday is the 16th.
    const sunday = Date.UTC(2026, 10, 15, 12, 0)
    expect(new Date(nextWake({ kind: "daily", at: "09:00", days: [1], timezone: "UTC" }, sunday)!).toISOString()).toBe("2026-11-16T09:00:00.000Z")
    const monday10 = Date.UTC(2026, 10, 16, 10, 0)
    expect(new Date(nextWake({ kind: "daily", at: "09:00", days: [1], timezone: "UTC" }, monday10)!).toISOString()).toBe("2026-11-23T09:00:00.000Z")
    const local = nextWake({ kind: "daily", at: "09:00", days: [1] }, sunday)!
    expect(new Date(local).getDay()).toBe(1)
    expect(local - sunday).toBeLessThan(8 * 86_400_000)
  })
})

describe("bot skills", () => {
  test("a skill is a SKILL.md in the bot's own folder; create refuses a taken name, update needs an existing one, secrets are redacted", () => {
    const dir = temp()
    const bot = port(dir)
    expect(bot.skillNeedsApproval("triage")).toBe(true)
    expect(bot.skillSave({ mode: "update", name: "triage", body: "x" })).toMatchObject({ ok: false })
    const saved = bot.skillSave({ mode: "create", name: "triage", description: "Sort incoming issues", body: "Use key sk-abc123 to call the API" })
    expect(saved).toMatchObject({ ok: true })
    const file = path.join(dir, "bots", "calm", "skills", "triage", "SKILL.md")
    expect(readFileSync(file, "utf8")).toContain("name: triage")
    expect(readFileSync(file, "utf8")).not.toContain("sk-abc123")
    expect(bot.skillSave({ mode: "create", name: "triage", description: "d", body: "b" })).toMatchObject({ ok: false })
    expect(bot.skillNeedsApproval("triage")).toBe(false)
    expect(bot.skillSave({ mode: "update", name: "triage", body: "Newer steps" })).toMatchObject({ ok: true })
    expect(bot.skillRead("triage")).toMatchObject({ ok: true, text: expect.stringContaining("Newer steps") })
    expect(listBotSkills({ dir, name: "calm" })).toEqual([{ name: "triage", description: "Sort incoming issues" }])
    expect(listBotSkills({ dir, name: "other" })).toEqual([])
  })

  test("bad names and empty skills are refused, and nothing is written", () => {
    const dir = temp()
    const bot = port(dir)
    expect(bot.skillSave({ mode: "create", name: "../escape", description: "d", body: "b" })).toMatchObject({ ok: false })
    expect(bot.skillSave({ mode: "create", name: "ok", description: "", body: "b" })).toMatchObject({ ok: false })
    expect(bot.skillSave({ mode: "create", name: "ok", description: "d", body: "" })).toMatchObject({ ok: false })
    expect(listBotSkills({ dir, name: "calm" })).toEqual([])
  })

  test("the prompt index is one line per skill and never passes its cap; the rest is counted", () => {
    const dir = temp()
    const bot = port(dir)
    for (let index = 0; index < 30; index++) bot.skillSave({ mode: "create", name: `skill-${String(index).padStart(2, "0")}`, description: `Does the thing number ${index} ${"x".repeat(100)}`, body: "steps" })
    const text = botSkillsPrompt({ dir, name: "calm" })
    expect(text.length).toBeLessThanOrEqual(BOT_SKILLS_PROMPT_MAX)
    expect(text).toContain("- skill-00:")
    expect(text).toMatch(/- … and \d+ more/)
    expect(botSkillsPrompt({ dir, name: "other" })).toBe("")
  })
})

describe("bot notes", () => {
  test("a note is kept in the project or everywhere, redacted, and a repeat is reported as known", () => {
    const dir = temp()
    const bot = port(dir)
    expect(bot.note({ text: "Deploys go through staging first sk-abc123", scope: "project" })).toMatchObject({ ok: true, text: expect.stringContaining("Learned") })
    expect(bot.note({ text: "Deploys go through staging first sk-abc123", scope: "project" })).toMatchObject({ ok: true, text: expect.stringContaining("Already known") })
    const projects = path.join(dir, "bots", "calm", "projects")
    expect(readFileSync(path.join(projects, readdirSync(projects)[0]!), "utf8")).toContain("Deploys go through staging first [secret]")
  })
})

describe("the workspace overview", () => {
  const active = (index: number) => ({ sessionId: `ses_${index}`, title: `Task number ${index} ${"y".repeat(50)}`, directory: `/work/project-${index}`, status: index % 2 ? "running" : "waiting_approval" })

  test("lists the sessions active now across folders, leaves out the bot's own and idle ones", () => {
    const text = workspaceOverview({ excludeSessionId: "ses_me", sessions: [{ ...active(1), sessionId: "ses_me" }, active(2), { ...active(3), status: "idle" }, active(5)] })
    expect(text).toContain("# Workspace now")
    expect(text).toContain('project-2 · "Task number 2')
    expect(text).toContain("waiting")
    expect(text).toContain("project-5")
    expect(text).not.toContain("project-1")
    expect(text).not.toContain("project-3")
  })

  test("never passes its cap and counts what it leaves out; nothing active gives no block", () => {
    const text = workspaceOverview({ excludeSessionId: "x", sessions: Array.from({ length: 12 }, (_, index) => active(index)) })
    expect(text.length).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS)
    expect(text).toMatch(/- … and \d+ more/)
    expect(workspaceOverview({ excludeSessionId: "x", sessions: [{ ...active(1), status: "idle" }] })).toBe("")
  })
})
