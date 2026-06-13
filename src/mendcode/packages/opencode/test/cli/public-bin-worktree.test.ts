import { describe, expect, test } from "bun:test"
import { resolveWorktreeShortcutTarget } from "../../src/mend/cli/public-bin"

function status(input: {
  currentPath?: string
  currentBranch?: string | null
  repoRoot?: string
  isLinkedWorktree?: boolean
  records?: Array<{ id: string; path: string; branch: string | null }>
  external?: Array<{ path: string; branch: string | null }>
}) {
  return {
    workspace: {
      currentPath: input.currentPath ?? "/repo",
      currentBranch: input.currentBranch ?? "main",
      repoRoot: input.repoRoot ?? "/repo",
      isLinkedWorktree: input.isLinkedWorktree ?? false,
      stateRoot: input.repoRoot ?? "/repo",
    },
    registry: {
      records: input.records ?? [],
      external: input.external ?? [],
      stale: [],
      drifted: [],
    },
  } as any
}

describe("mend public worktree shortcuts", () => {
  test("infers the current linked worktree when no target is provided", () => {
    const result = resolveWorktreeShortcutTarget(status({
      currentPath: "/repo-wt",
      currentBranch: "mend/demo",
      isLinkedWorktree: true,
      repoRoot: "/repo",
    }))

    expect(result).toMatchObject({ path: "/repo-wt", branch: "mend/demo" })
  })

  test("resolves explicit branch targets", () => {
    const result = resolveWorktreeShortcutTarget(status({
      records: [{ id: "one", path: "/repo-wt", branch: "mend/demo" }],
    }), "mend/demo")

    expect(result).toMatchObject({ path: "/repo-wt", branch: "mend/demo" })
  })

  test("requires a target when the base repo has multiple worktrees", () => {
    expect(() =>
      resolveWorktreeShortcutTarget(status({
        external: [
          { path: "/repo-a", branch: "mend/a" },
          { path: "/repo-b", branch: "mend/b" },
        ],
      })),
    ).toThrow("Multiple or no worktree targets")
  })
})
