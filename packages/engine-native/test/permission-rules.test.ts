import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { createGrantStore, createNativeEngine, memoryHistory, questionTool, type ModelEvent } from "../src"
import { configRules, declaredRoots, externalPatterns, matchingRule, permissionMatch, policyRules, splitDeclared, toolDisabled } from "../src/permission-rules"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b32-permissions-"))); dirs.push(dir); return dir }

function scenario(steps: ModelEvent[][], settings: Pick<Settings, "permission" | "tools" | "experimental" | "additionalDirectories"> = {}, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const cwd = temp()
  const log: string[] = []
  const tools = ["read", "write", "shell"].map((name) => defineTool({ name, description: name, permission: name === "read" ? "read" : name === "write" ? "write" : "execute", args: z.object({ path: z.string().optional(), command: z.string().optional(), workdir: z.string().optional() }), execute: async (args) => { log.push(`${name}:${args.path ?? args.command}`); return { output: "ok", title: name, isError: false, truncated: false } } }))
  const { provider, requests } = scriptedProvider(steps)
  const history = memoryHistory()
  const grants = createGrantStore()
  const engine = createNativeEngine({ provider, tools, history, grants, cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings, ...extra })
  return { cwd, log, requests, history, grants, engine }
}

describe("ordered permission rules", () => {
  test("last match, wildcards, shell alias, edit family, home expansion and explicit permission over tools", () => {
    const rules = policyRules({ tools: { write: false }, permission: { edit: { "*": "ask", "~/project/*": "allow", "*/secret?": "deny" }, shell: { "git *": "allow" } } })
    expect(matchingRule("edit", `${homedir()}/project/a`, rules)?.action).toBe("allow")
    expect(matchingRule("edit", `${homedir()}/project/secret1`, rules)?.action).toBe("deny")
    expect(matchingRule("bash", "git", rules)?.action).toBe("allow")
    expect(permissionMatch("x\ny", "x*y")).toBe(true)
    expect(permissionMatch("a.ts", "a.ts")).toBe(true)
    expect(permissionMatch("aXts", "a.ts")).toBe(false)
    expect(toolDisabled("apply_patch", rules)).toBe(false)
    expect(toolDisabled("write", configRules({ edit: "deny" }))).toBe(true)
    expect(matchingRule("read", "a", policyRules({ permission: "deny" }, [{ permission: "read", pattern: "*", action: "allow" }]))?.action).toBe("allow")
  })

  test("read ask runs only after approval, then a deny wins over a grant and full mode", async () => {
    let permission: Settings["permission"] = { read: "ask" }
    const s = scenario([callTool("read", { path: "a.ts" }), stop("ok"), callTool("read", { path: "a.ts" }), stop("denied")], {}, { permissionPolicy: () => ({ permission }) })
    const first = turn({ text: "read", answers: [{ kind: "approve", scope: "session" }] })
    await s.engine.runTurn(first.input)
    expect(first.asked).toHaveLength(1)
    expect(s.log).toEqual(["read:a.ts"])
    permission = { read: { "*/a.ts": "deny" } }
    const second = turn({ text: "again", sessionId: first.input.sessionId, mode: () => "full" })
    await s.engine.runTurn(second.input)
    expect(second.asked).toEqual([])
    expect(s.log).toHaveLength(1)
    expect(s.requests.at(-1)?.messages.at(-1)).toMatchObject({ isError: true, output: expect.stringContaining("permission rule") })
  })

  test("global tools false hides and rejects calls; primary-only also removes project tools from children", async () => {
    const s = scenario([callTool("write", { path: "a" }), callTool("shell", { command: "pwd" }), stop("ok")], { tools: { write: false }, experimental: { primary_tools: ["shell", "mcp__private__*"] } }, {
      tasks: { isChild: () => true, run: async () => { throw new Error("unexpected task") }, status: async () => "" },
      projectTools: async () => [defineTool({ name: "mcp__private__read", description: "private", permission: "read", args: z.object({}), execute: async () => { throw new Error("must not run") } })],
    })
    await s.engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(s.requests[0]?.tools.map((tool) => tool.name)).not.toContain("write")
    expect(s.requests[0]?.tools.map((tool) => tool.name)).not.toContain("shell")
    expect(s.requests[0]?.tools.map((tool) => tool.name)).not.toContain("mcp__private__read")
    expect(s.log).toEqual([])
  })

  test("agent patterns override global rules but cannot let writes bypass plan mode", async () => {
    const s = scenario([callTool("read", { path: "a" }), callTool("write", { path: "a" }), stop("ok")], { permission: "deny" }, { agents: { primary: () => ({ name: "audit", description: "audit", mode: "primary", prompt: "", permission: "plan", permissionRules: [{ permission: "read", pattern: "*", action: "allow" }, { permission: "edit", pattern: "*", action: "allow" }] }), subagents: () => [] } })
    await s.engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(s.log).toEqual(["read:a"])
    expect(s.requests.at(-1)?.messages.at(-1)).toMatchObject({ output: expect.stringContaining("plan mode") })
  })

  test("an extension argument rewrite is checked again against path rules", async () => {
    const s = scenario([callTool("write", { path: "safe.ts" }), stop("ok")], { permission: { edit: { "*": "allow", "*/private.ts": "deny" } } }, { hooks: { has: (event) => event === "tool.before", toolBefore: async () => ({ args: { path: "private.ts" } }) } })
    await s.engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(s.log).toEqual([])
  })

  test("a repeated internal tool still obeys a newly changed path rule", async () => {
    let calls = 0
    const s = scenario([...Array.from({ length: 3 }, () => callTool("task", { agent: "review", description: "Review", prompt: "Inspect types" })), stop("denied")], {}, {
      subagents: true,
      permissionPolicy: () => ({ permission: { task: { "*": "allow", review: calls >= 2 ? "deny" : "allow" }, doom_loop: "allow" } }),
      tasks: { isChild: () => false, status: async () => "", run: async () => { calls++; throw new Error("local task failed") } },
    })
    const t = turn({ text: "go" })
    await s.engine.runTurn(t.input)
    expect(calls).toBe(2)
    expect(t.asked).toEqual([])
    expect((await s.history.load(t.input.sessionId))?.at(-2)).toMatchObject({ output: expect.stringContaining("task review"), isError: true })
  })
})

describe("external directory and doom loop", () => {
  test("external reads have their own prompt and session grants stay scoped to the directory", async () => {
    const outside = temp(), other = temp()
    const s = scenario([callTool("read", { path: path.join(outside, "a") }), callTool("read", { path: path.join(outside, "b") }), callTool("read", { path: path.join(outside, "nested", "c") }), callTool("read", { path: path.join(other, "c") }), stop("ok")])
    const t = turn({ text: "go", answers: [{ kind: "approve", scope: "session" }, { kind: "deny" }] })
    await s.engine.runTurn(t.input)
    expect(t.asked.map((request) => request.title)).toEqual(["external directory access", "external directory access"])
    expect(s.log).toHaveLength(3)
    expect(s.grants.list(t.input.sessionId)).toMatchObject([{ rulePermission: "external_directory", pattern: path.join(outside, "*") }])
    expect(s.grants.revoke(t.input.sessionId, s.grants.list(t.input.sessionId)[0]!.grantId)).toBe(1)
  })

  test("symlinks, patch deletion/moves and shell cwd/redirects cannot hide external targets", () => {
    const cwd = temp(), outside = temp()
    symlinkSync(outside, path.join(cwd, "linked"))
    expect(externalPatterns("read", { path: "linked/file" }, cwd)).toEqual([path.join(outside, "*")])
    expect(externalPatterns("apply_patch", { patch: `*** Delete File: ${outside}/a\n*** Update File: local\n*** Move to: ${outside}/b` }, cwd)).toEqual([path.join(outside, "*")])
    expect(externalPatterns("shell", { command: "cat a > ../output", workdir: outside }, cwd)).toContain(path.join(outside, "*"))
    expect(externalPatterns("shell", { command: `cd '${outside}' && cat file` }, cwd)).toContain(path.join(outside, "*"))
  })

  test("declared extra directories skip the external ask for the setting and the session list, symlinks included", async () => {
    const outside = temp(), other = temp(), session = temp()
    const settingsOnly = scenario([callTool("read", { path: path.join(outside, "a") }), stop("ok")], { additionalDirectories: [outside] } as Settings)
    const first = turn({ text: "go" })
    await settingsOnly.engine.runTurn(first.input)
    expect(first.asked).toEqual([])
    expect(settingsOnly.log).toEqual([`read:${path.join(outside, "a")}`])

    const sessionList = scenario([callTool("write", { path: path.join(session, "b") }), stop("ok")], {}, { runLimits: () => ({ addDirs: [session] }) })
    const second = turn({ text: "go", mode: () => "edits" })
    await sessionList.engine.runTurn(second.input)
    expect(second.asked).toEqual([])
    expect(sessionList.log).toEqual([`write:${path.join(session, "b")}`])

    const undeclared = scenario([callTool("read", { path: path.join(other, "c") }), stop("ok")], { additionalDirectories: [outside] } as Settings)
    const third = turn({ text: "go", answers: [{ kind: "deny" }] })
    await undeclared.engine.runTurn(third.input)
    expect(third.asked.map((request) => request.title)).toEqual(["external directory access"])

    const linked = temp()
    symlinkSync(outside, path.join(linked, "via"))
    expect(splitDeclared(externalPatterns("read", { path: path.join(linked, "via", "x") }, linked), declaredRoots([outside]))).toEqual({ external: [], declared: [path.join(outside, "*")] })
  })

  test("an explicit external_directory deny still wins inside a declared directory; relative entries are ignored", async () => {
    const outside = temp()
    const s = scenario([callTool("read", { path: path.join(outside, "a") }), stop("ok")], { additionalDirectories: [outside], permission: { external_directory: { [path.join(outside, "*")]: "deny" } } } as Settings)
    const t = turn({ text: "go", mode: () => "full" })
    await s.engine.runTurn(t.input)
    expect(s.log).toEqual([])
    expect(declaredRoots(["relative/dir", "", outside])).toEqual([outside])
  })

  test("external deny is respected in full mode and an external allow leaves ordinary tool approval intact", async () => {
    const outside = temp()
    const denied = scenario([callTool("read", { path: path.join(outside, "a") }), stop("ok")], { permission: { external_directory: "deny" } })
    await denied.engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(denied.log).toEqual([])
    const allowed = scenario([callTool("write", { path: path.join(outside, "a") }), stop("ok")], { permission: { external_directory: "allow" } })
    const t = turn({ text: "go", answers: [{ kind: "approve", scope: "once" }] })
    await allowed.engine.runTurn(t.input)
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]?.title).toBe("Edit files")
  })

  test("third identical action asks, rejection stops the turn and closes the remaining tool results", async () => {
    const calls = [callTool("read", { path: "a" }), callTool("read", { path: "a" }), [...callTool("read", { path: "a" }), ...callTool("read", { path: "b" })]]
    const s = scenario(calls)
    const t = turn({ text: "go", answers: [{ kind: "deny", reason: "stop repeating" }] })
    expect(await s.engine.runTurn(t.input)).toEqual({ status: "ok" })
    expect(s.log).toEqual(["read:a", "read:a"])
    expect(t.asked[0]?.title).toBe("repeated tool action")
    const saved = await s.history.load(t.input.sessionId)
    expect(saved?.at(-1)).toMatchObject({ role: "tool", output: "cancelled", isError: true })
  })

  test("full mode refuses the third identical action without asking and the model goes on", async () => {
    const s = scenario([callTool("read", { path: "a" }), callTool("read", { path: "a" }), callTool("read", { path: "a" }), callTool("read", { path: "b" }), stop("adapted")])
    const t = turn({ text: "go", mode: () => "full" })
    await s.engine.runTurn(t.input)
    expect(t.asked).toEqual([])
    expect(s.log).toEqual(["read:a", "read:a", "read:b"])
    expect(s.requests[3]?.messages.at(-1)).toMatchObject({ isError: true, output: expect.stringContaining("ran 3 times in a row") })
  })

  test("continue_loop_on_deny permits another model step; doom_loop allow prevents repetition prompts", async () => {
    const s = scenario([callTool("shell", { command: "custom" }), callTool("read", { path: "a" }), stop("adapted")], { experimental: { continue_loop_on_deny: true } })
    const t = turn({ text: "go", answers: [{ kind: "deny" }] })
    await s.engine.runTurn(t.input)
    expect(s.log).toEqual(["read:a"])
    const allowed = scenario([...Array.from({ length: 4 }, () => callTool("read", { path: "a" })), stop("ok")], { permission: { doom_loop: "allow" } })
    const a = turn({ text: "go" })
    await allowed.engine.runTurn(a.input)
    expect(a.asked).toEqual([])
    expect(allowed.log).toHaveLength(4)
  })

  test("normal user rejection stops by default and a batch has matching cancelled results", async () => {
    const s = scenario([[...callTool("shell", { command: "custom" }), ...callTool("read", { path: "a" })], stop("never")])
    const t = turn({ text: "go", answers: [{ kind: "deny" }] })
    await s.engine.runTurn(t.input)
    expect(s.requests).toHaveLength(1)
    expect(s.log).toEqual([])
    expect((await s.history.load(t.input.sessionId))?.at(-1)).toMatchObject({ output: "cancelled" })
  })
})


test("hosted tools obey global denies and primary-only settings without contacting a provider service", async () => {
  const denied = scenario([stop("ok")], { tools: { websearch: false } }, { hostedTools: () => ["web_search", "image_generation"] })
  await denied.engine.runTurn(turn({ text: "go" }).input)
  expect(denied.requests[0]?.hostedTools).toEqual(["image_generation"])
  const child = scenario([stop("ok")], { experimental: { primary_tools: ["web_search"] } }, { hostedTools: () => ["web_search"], tasks: { isChild: () => true, run: async () => { throw new Error("unexpected task") }, status: async () => "" } })
  await child.engine.runTurn(turn({ text: "go" }).input)
  expect(child.requests[0]?.hostedTools).toBeUndefined()
})


test("a declined question stops by default and preserves its tool result", async () => {
  const s = scenario([callTool("question", { question: "Proceed?" }), stop("never")], {}, { tools: [questionTool] })
  const t = turn({ text: "go", answers: [{ kind: "deny", reason: "no" }] })
  await s.engine.runTurn(t.input)
  expect(s.requests).toHaveLength(1)
  expect((await s.history.load(t.input.sessionId))?.at(-1)).toMatchObject({ output: "not answered: no", isError: true })
})

test("credential reads ask by default while the example file is allowed", async () => {
  const s = scenario([callTool("read", { path: ".env" }), callTool("read", { path: ".env.example" }), stop("ok")])
  const t = turn({ text: "go", answers: [{ kind: "approve", scope: "once" }] })
  await s.engine.runTurn(t.input)
  expect(t.asked).toHaveLength(1)
  expect(t.asked[0]?.detail).toContain(".env")
  expect(s.log).toEqual(["read:.env", "read:.env.example"])
})

test("primary-only filtering also applies to an inline task while the parent retains the tool", async () => {
  const s = scenario([callTool("task", { description: "Inspect types", prompt: "Read a" }), callTool("read", { path: "a" }), stop("child done"), stop("parent done")], { experimental: { primary_tools: ["read"] } }, { subagents: true })
  await s.engine.runTurn(turn({ text: "go" }).input)
  expect(s.requests[0]?.tools.map((tool) => tool.name)).toContain("read")
  expect(s.requests[1]?.tools.map((tool) => tool.name)).not.toContain("read")
  expect(s.log).toEqual([])
  expect(s.requests[2]?.messages.at(-1)).toMatchObject({ output: "unknown tool: read", isError: true })
})
