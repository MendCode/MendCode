import { z } from "zod"
import { defineTool } from "../tool"
import { fail } from "../util"

const ACTIONS = ["enter", "exit", "status", "list", "handoff", "close"] as const

/**
 * `worktree`: lets the agent work in an isolated git worktree. `enter` creates one (own branch, under the data directory)
 * and moves the session into it, so the file and shell tools that follow run there and the user's checkout stays as it
 * was; `handoff` moves into one that already exists; `exit` moves back and can remove the worktree when it is clean and
 * merged; `list` and `close` show and remove the project's worktrees. The user approves each change.
 */
export const worktreeTool = defineTool({
  name: "worktree",
  description: [
    "Work in an isolated git worktree. action enter: create a new git worktree on its own branch (under MendCode's data directory, never inside the user's checkout) and move this session into it, so every later file and shell tool call runs there.",
    "enter takes an optional name, an optional base (a branch or ref to start from, for a change stacked on another) and, when the worktreeBranch setting asks for it (status says), a branch name.",
    "action handoff: move this session into an existing worktree of the project (target: name, branch, id or directory from list). action list: the project's worktrees and where this session works.",
    "action exit: move the session back to the project's own checkout; remove true also deletes the worktree when it is clean and its branch is merged, otherwise the worktree and its branch are kept for the user.",
    "action close: delete a worktree (target from list; this session's own when omitted) that is clean, merged and has no session in it. action status: where the session works and how branches are named.",
    "Use it when the user asks for isolated work or an experiment that must not touch their checkout. It needs a git repository, an idle session (no background commands, no running sub-agents) and the user approves every change. Commit your work in the worktree before you leave it.",
  ].join(" "),
  permission: "write",
  permissionFor: (args) => (args.action === "status" || args.action === "list" ? "read" : "write"),
  args: z.object({
    action: z.enum(ACTIONS).describe("enter a new worktree, hand off into an existing one, exit back to the checkout, close one, list them, or show where the session works"),
    name: z.string().min(1).max(60).optional().describe("enter: a short name for the worktree and its branch (a random one when omitted)"),
    branch: z.string().min(1).max(100).optional().describe("enter: the branch name the worktreeBranch setting asks you to choose: a short type such as fix or feat (semantic) or the whole branch name (custom); ignored under the static prefix"),
    base: z.string().min(1).max(200).optional().describe("enter: the branch or ref the new branch starts from (default: the checkout's HEAD); use the parent branch to stack a change"),
    target: z.string().min(1).max(4096).optional().describe("handoff, close: a worktree's name, branch, id or directory, as list shows it"),
    remove: z.boolean().optional().describe("exit: also delete the worktree if it is clean and merged (default: keep it)"),
  }),
  async preview(args, context) {
    if (args.action === "status" || args.action === "list" || !context.worktrees) return undefined
    const checked = await context.worktrees.preview({ action: args.action, name: args.name, branch: args.branch, base: args.base, target: args.target, remove: args.remove }).catch(() => undefined)
    if (!checked) return undefined
    return checked.problems.length ? `Problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}` : checked.detail
  },
  async execute(args, context) {
    const title = `worktree ${args.action}`
    const port = context.worktrees
    if (!port) return fail({ title, message: "worktrees are not available here" })
    if (args.action === "status") return { output: port.status(), truncated: false, title: "worktree", isError: false }
    if (args.action === "list") {
      if (!port.list) return fail({ title, message: "listing worktrees is not available here" })
      return { output: await port.list(), truncated: false, title: "worktree list", isError: false }
    }
    if (args.action === "close") {
      if (!port.close) return fail({ title, message: "closing worktrees is not available here" })
      const closed = await port.close({ target: args.target })
      if (!closed.ok) return fail({ title, message: closed.message })
      return { output: closed.text, truncated: false, title: "worktree closed", isError: false, ...(closed.directory ? { meta: { directory: closed.directory } } : {}) }
    }
    if (args.action === "handoff") {
      if (!port.handoff) return fail({ title, message: "handing off to an existing worktree is not available here" })
      if (!args.target) return fail({ title, message: "handoff needs target (a name, branch, id or directory from list)" })
      const moved = await port.handoff({ target: args.target })
      if (!moved.ok) return fail({ title, message: moved.message })
      return { output: moved.text, truncated: false, title: "worktree entered", isError: false, meta: { directory: moved.directory } }
    }
    const moved = args.action === "enter" ? await port.enter({ name: args.name, branch: args.branch, base: args.base }) : await port.exit({ remove: args.remove })
    if (!moved.ok) return fail({ title, message: moved.message })
    return { output: moved.text, truncated: false, title: `worktree ${args.action === "enter" ? "entered" : "left"}`, isError: false, meta: { directory: moved.directory } }
  },
})
