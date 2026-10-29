import { expect, test } from "bun:test"
import { worktreeTool, type WorktreePort } from "../src"

function port(log: string[] = []): WorktreePort {
  return {
    status: () => "Working in the project checkout /repo.",
    preview: async (input) => (log.push(`preview ${JSON.stringify(input)}`), input.action === "exit" ? { problems: ["this session is not in a worktree"] } : { problems: [], detail: "Create a worktree." }),
    enter: async ({ name }) => (log.push(`enter ${name ?? ""}`), { ok: true, text: "Entered worktree.", directory: "/data/worktrees/x" }),
    exit: async ({ remove }) => (log.push(`exit ${remove ? "remove" : "keep"}`), { ok: false, message: "this session is not in a worktree" }),
  }
}
const context = (worktrees?: WorktreePort) => ({ cwd: "/repo", signal: new AbortController().signal, ...(worktrees ? { worktrees } : {}) })

test("the worktree tool is a write tool except for status, and validates its arguments", () => {
  expect(worktreeTool.permission).toBe("write")
  expect(worktreeTool.permissionFor?.({ action: "status" })).toBe("read")
  expect(worktreeTool.permissionFor?.({ action: "enter" })).toBe("write")
  expect(worktreeTool.args.safeParse({ action: "enter", name: "idea" }).success).toBe(true)
  expect(worktreeTool.args.safeParse({ action: "delete" }).success).toBe(false)
  expect(worktreeTool.args.safeParse({ action: "enter", name: "" }).success).toBe(false)
})

test("enter, exit and status go through the port and report its answer", async () => {
  const log: string[] = []
  const entered = await worktreeTool.execute({ action: "enter", name: "idea" }, context(port(log)))
  expect(entered).toMatchObject({ isError: false, output: "Entered worktree.", title: "worktree entered", meta: { directory: "/data/worktrees/x" } })
  expect(await worktreeTool.execute({ action: "status" }, context(port(log)))).toMatchObject({ isError: false, output: "Working in the project checkout /repo." })
  const left = await worktreeTool.execute({ action: "exit", remove: true }, context(port(log)))
  expect(left).toMatchObject({ isError: true, output: "this session is not in a worktree" })
  expect(log).toEqual(["enter idea", "exit remove"])
})

test("without a port the tool says it is unavailable, and its preview shows the plan or the problems", async () => {
  expect(await worktreeTool.execute({ action: "enter" }, context())).toMatchObject({ isError: true, output: "worktrees are not available here" })
  expect(await worktreeTool.preview?.({ action: "enter" }, context())).toBeUndefined()
  expect(await worktreeTool.preview?.({ action: "status" }, context(port()))).toBeUndefined()
  expect(await worktreeTool.preview?.({ action: "enter", name: "x" }, context(port()))).toBe("Create a worktree.")
  expect(await worktreeTool.preview?.({ action: "exit" }, context(port()))).toBe("Problems:\n- this session is not in a worktree")
})
