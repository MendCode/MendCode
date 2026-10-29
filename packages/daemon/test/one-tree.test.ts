import { describe, expect, test } from "bun:test"
import type { SessionId } from "@mendcode/protocol"
import { createOneTree, mentionsPath, ONE_TREE_LIVE_MS } from "../src/one-tree"

const PETS = "ses_pets" as SessionId
const DOCS = "ses_docs" as SessionId
const REPO = "/repo"

function tree(options: { enabled?: boolean } = {}) {
  let now = 1_000_000
  const titles: Record<string, string> = { [PETS]: "Pets", [DOCS]: "", [`${PETS}#astra-4`]: "a sub-agent of «Pets»" }
  const oneTree = createOneTree({ now: () => now, enabled: () => options.enabled ?? true, title: (id) => titles[id] })
  const call = (sessionId: SessionId, output: string, written: string[] = []) => oneTree.note({ sessionId, cwd: REPO, written, output })
  return { oneTree, call, advance: (ms: number) => void (now += ms) }
}

describe("a path named in a tool's output", () => {
  test("counts as a whole path, not as the tail of a longer one or the start of a longer name", () => {
    expect(mentionsPath(" M apps/cli/src/art.ts", "apps/cli/src/art.ts")).toBe(true)
    expect(mentionsPath("apps/cli/src/art.ts:12:3 - error TS2322", "apps/cli/src/art.ts")).toBe(true)
    expect(mentionsPath("diff --git a/apps/art.ts b/apps/art.ts", "apps/art.ts")).toBe(true)
    expect(mentionsPath("+++ b/apps/art.ts", "apps/art.ts")).toBe(true)
    expect(mentionsPath("ls ./art.ts", "art.ts")).toBe(true)
    expect(mentionsPath("lib/apps/art.ts", "apps/art.ts")).toBe(false)
    expect(mentionsPath("src/data.ts", "a.ts")).toBe(false)
    expect(mentionsPath("other/apps/cli/src/art.ts", "apps/cli/src/art.ts")).toBe(false)
    expect(mentionsPath("apps/cli/src/art.tsx", "apps/cli/src/art.ts")).toBe(false)
    expect(mentionsPath("apps/cli/src/art.ts.map", "apps/cli/src/art.ts")).toBe(false)
  })
})

describe("one tree", () => {
  test("a session working alone gets nothing, whatever it writes or prints", () => {
    const { call } = tree()
    expect(call(PETS, "", ["apps/cli/src/art.ts"])).toBeUndefined()
    expect(call(PETS, " M apps/cli/src/art.ts")).toBeUndefined()
  })

  test("a git status naming a file another session wrote gets one line with its title and age, and not twice in a row", () => {
    const { call, advance } = tree()
    call(PETS, "", ["apps/cli/src/art.ts"])
    advance(3 * 60_000)
    const line = call(DOCS, " M apps/cli/src/art.ts\n M docs/one-tree.md")
    expect(line).toBe("[one tree] Other sessions are changing these files in this checkout: apps/cli/src/art.ts («Pets», 3 min ago). They are not the user's edits and not unfinished work of yours: leave them, do not revert or fix them, and commit only the files you changed.")
    expect(call(DOCS, " M apps/cli/src/art.ts")).toBeUndefined()
    // Named again once the quiet time has passed and the file is still being worked on.
    advance(11 * 60_000)
    call(PETS, "", ["apps/cli/src/art.ts"])
    expect(call(DOCS, "apps/cli/src/art.ts:4:1 error")).toContain("apps/cli/src/art.ts («Pets», now)")
  })

  test("one of Claude Code's sub-agents is a writer of its own: the session it works for is told about its files", () => {
    const { call } = tree()
    call(`${PETS}#astra-4` as SessionId, "", ["/repo/src/tabs.swift"])
    expect(call(PETS, "M src/tabs.swift")).toContain("src/tabs.swift (a sub-agent of «Pets», now)")
  })

  test("writing a file another session is changing is said on the write itself, and an untitled session is another session", () => {
    const { call } = tree()
    call(DOCS, "", ["/repo/docs/one-tree.md"])
    expect(call(PETS, "wrote", ["docs/one-tree.md"])).toContain("docs/one-tree.md (another session, now)")
  })

  test("a file the other session wrote longer ago than the live window is not anyone's work any more", () => {
    const { call, advance } = tree()
    call(PETS, "", ["apps/cli/src/art.ts"])
    advance(ONE_TREE_LIVE_MS + 1)
    expect(call(DOCS, " M apps/cli/src/art.ts")).toBeUndefined()
  })

  test("off (minimalist, or /tier one_tree off): nothing is recorded and nothing is said", () => {
    const { call } = tree({ enabled: false })
    call(PETS, "", ["apps/cli/src/art.ts"])
    expect(call(DOCS, " M apps/cli/src/art.ts")).toBeUndefined()
  })

  test("many files: the newest six are named and the rest counted; a deleted session's files are forgotten", () => {
    const { oneTree, call, advance } = tree()
    for (let index = 0; index < 8; index++) { call(PETS, "", [`f${index}.ts`]); advance(1_000) }
    const line = call(DOCS, Array.from({ length: 8 }, (_, index) => `f${index}.ts`).join("\n"))!
    expect(line).toContain("f7.ts («Pets», now)")
    expect(line).not.toContain("f1.ts")
    expect(line).toContain("and 2 more")
    oneTree.forget(PETS)
    advance(11 * 60_000)
    expect(call(DOCS, "f7.ts")).toBeUndefined()
  })
})
