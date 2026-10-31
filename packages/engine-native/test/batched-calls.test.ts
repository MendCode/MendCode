import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { edit, read } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { contextFiles, readPaths } from "../src/context-files"
import { resolveToolArgs } from "../src/secrets"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function project() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-batched-")))
  cleanup.push(dir)
  return dir
}

const SECRET = "sk-live-0123456789abcdef"
const secrets = {
  list: () => [{ n: 1, marker: "‹secret:1›", kind: "api key", tail: "cdef" }],
  resolve: (_: unknown, text: string) => text.replaceAll("‹secret:1›", SECRET),
  mask: (_: unknown, text: string) => text.replaceAll(SECRET, "‹secret:1›"),
  stream: () => undefined,
}

describe("secret markers inside edit's edits", () => {
  test("resolveToolArgs resolves markers at the top level and in every entry of edits, and copies instead of mutating", () => {
    const args = {
      path: "‹secret:1›.env",
      oldString: "KEY=‹secret:1›",
      newString: "KEY=x",
      edits: [{ oldString: "A=‹secret:1›", newString: "A=‹secret:1›!", replaceAll: true }, { oldString: "b", newString: "‹secret:1›" }, "junk"],
    }
    const resolve = (text: string) => text.replaceAll("‹secret:1›", SECRET)
    expect(resolveToolArgs({ tool: "edit", args, resolve })).toEqual({
      // A path is never a secret-bearing field.
      path: "‹secret:1›.env",
      oldString: `KEY=${SECRET}`,
      newString: "KEY=x",
      edits: [{ oldString: `A=${SECRET}`, newString: `A=${SECRET}!`, replaceAll: true }, { oldString: "b", newString: SECRET }, "junk"],
    })
    expect(args.edits[0]).toEqual({ oldString: "A=‹secret:1›", newString: "A=‹secret:1›!", replaceAll: true })
    expect(resolveToolArgs({ tool: "read", args: { paths: [{ path: "‹secret:1›" }] }, resolve })).toEqual({ paths: [{ path: "‹secret:1›" }] })
    expect(resolveToolArgs({ tool: "edit", args: { path: "f", edits: "nope" }, resolve })).toEqual({ path: "f", edits: "nope" })
  })

  test("through the engine: the file gets the value, the approval, the events and the next request see only the marker", async () => {
    const root = project()
    writeFileSync(path.join(root, ".env.example"), `API_KEY=${SECRET}\nMODE=dev\n`)
    const { provider, requests } = scriptedProvider([
      callTool("edit", { path: ".env.example", edits: [{ oldString: "API_KEY=‹secret:1›", newString: "API_KEY=‹secret:1›\nAPI_KEY_BACKUP=‹secret:1›" }, { oldString: "MODE=dev", newString: "MODE=prod" }] }),
      stop("done"),
    ])
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [edit], cwdFor: () => root, system: () => "sys", compactionPrompt: "s", secrets })
    const t = turn({ text: "rotate", answers: [{ kind: "approve", scope: "once" }] })
    expect(await engine.runTurn(t.input)).toEqual({ status: "ok" })
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).toBe(`API_KEY=${SECRET}\nAPI_KEY_BACKUP=${SECRET}\nMODE=prod\n`)
    expect(t.asked).toHaveLength(1)
    expect(JSON.stringify(t.asked)).not.toContain(SECRET)
    expect(JSON.stringify(t.events)).not.toContain(SECRET)
    expect(JSON.stringify(requests)).not.toContain(SECRET)
    expect(JSON.stringify(requests[1]!.messages)).toContain("API_KEY_BACKUP=‹secret:1›")
  })
})

describe("read with several paths", () => {
  test("an entry that a rule asks about makes the whole call ask, and a denial reads none of them", async () => {
    const root = project()
    writeFileSync(path.join(root, "a.ts"), "export const a = 1\n")
    writeFileSync(path.join(root, ".env"), `TOKEN=${SECRET}\n`)
    const { provider, requests } = scriptedProvider([callTool("read", { paths: [{ path: "a.ts" }, { path: ".env" }] }), stop("done")])
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [read], cwdFor: () => root, system: () => "sys", compactionPrompt: "s" })
    const t = turn({ text: "look", answers: [{ kind: "deny" }] })
    await engine.runTurn(t.input)
    expect(t.asked).toHaveLength(1)
    expect(JSON.stringify(t.asked)).toContain(".env")
    // A denial ends the turn: nothing the files hold reached an event or another request.
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(t.events)).not.toContain("export const a")
    expect(JSON.stringify(t.events)).not.toContain(SECRET)
  })

  test("an entry outside the project asks for the external directory before anything is read", async () => {
    const root = project()
    const outside = project()
    writeFileSync(path.join(root, "a.ts"), "inside\n")
    writeFileSync(path.join(outside, "b.ts"), "outside\n")
    const { provider, requests } = scriptedProvider([callTool("read", { paths: [{ path: "a.ts" }, { path: path.join(outside, "b.ts") }] }), stop("done")])
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [read], cwdFor: () => root, system: () => "sys", compactionPrompt: "s" })
    const t = turn({ text: "look", answers: [{ kind: "deny" }] })
    await engine.runTurn(t.input)
    expect(t.asked).toHaveLength(1)
    expect(JSON.stringify(t.asked)).toContain(outside)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(t.events)).not.toContain("inside\\n")
    expect(JSON.stringify(t.events)).not.toContain("outside\\n")
  })

  test("the context report counts every file a multi-file read named, sharing the result's tokens", () => {
    expect(readPaths({ path: "a.ts" })).toEqual(["a.ts"])
    expect(readPaths({ paths: [{ path: "a.ts" }, { path: "b.ts", offset: 3 }, null, { nope: 1 }] })).toEqual(["a.ts", "b.ts"])
    const files = contextFiles({
      messages: [
        { role: "assistant", text: "", toolCalls: [{ callId: "c1", name: "read", args: { paths: [{ path: "a.ts" }, { path: "b.ts" }] } }] },
        { role: "tool", callId: "c1", name: "read", output: "x".repeat(400), isError: false },
      ] as never,
      tokensOf: () => 100,
    })
    expect(files.map((file) => [file.path, file.reads, file.tokens]).sort()).toEqual([["a.ts", 1, 50], ["b.ts", 1, 50]])
  })
})
