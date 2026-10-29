import { afterEach, expect, test } from "bun:test"
import type { AgentsReport } from "@mendcode/protocol"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const agents: AgentsReport = {
  directory: "/project",
  current: "build",
  problems: [],
  agents: [
    { name: "build", description: "The default agent", mode: "primary", source: "builtin", trusted: true },
    { name: "explore", description: "Find files, search code", mode: "subagent", source: "builtin", trusted: true },
    { name: "extractor", description: "Pulls data out", mode: "subagent", source: "user", trusted: true },
  ],
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function start() {
  const id = ids("session")
  const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", reply: (command) => {
    if (command.type === "agents.list") return { ok: true, result: agents }
    if (command.type === "files.search") return { ok: true, result: { files: [{ path: "src/explorer.ts", kind: "file" }] } }
  } })
  h.app.applySettings({ onboarded: true })
  return h
}

test("@ offers the sub-agents above the files, with an agent tag", async () => {
  const h = start()
  await flush()
  await h.type("ask @ex")
  await flush()
  const out = h.text().join("\n")
  expect(out).toContain("@explore")
  expect(out).toContain("@extractor")
  expect(out).toContain("@src/explorer.ts")
  expect(out).toContain("agent")
  expect(out).not.toContain("@build")
  expect(out.indexOf("@explore")).toBeLessThan(out.indexOf("@src/explorer.ts"))
})

test("tab completes the agent name and a trailing space, so the daemon can route it", async () => {
  const h = start()
  await flush()
  await h.type("ask @ex")
  await flush()
  await h.app.onKey("\t")
  expect(h.app.editor.text).toBe("ask @explore ")
})
