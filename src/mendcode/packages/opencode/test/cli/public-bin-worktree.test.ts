import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveWorktreeShortcutTarget } from "../../src/mend/cli/public-bin"

const publicBin = path.resolve(import.meta.dir, "../../src/mend/cli/public-bin.ts")

function runPublicBin(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", publicBin, ...args],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      MENDCODE_ROOT: path.resolve(import.meta.dir, "../.."),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

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

  test("prefers a single managed worktree over external worktrees from the base repo", () => {
    const result = resolveWorktreeShortcutTarget(status({
      records: [{ id: "owned", path: "/repo-owned", branch: "mend/owned" }],
      external: [{ path: "/repo-external", branch: "worktree/external" }],
    }))

    expect(result).toMatchObject({ path: "/repo-owned", branch: "mend/owned" })
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

describe("mend public CLI help", () => {
  test("--help emphasizes workflows and hides internal tui/config commands", () => {
    const result = runPublicBin(["--help"])
    const output = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(output).toContain("mendcode                         open MendCode")
    expect(output).toContain("mendcode packages status|list")
    expect(output).toContain("mendcode packages install <pack-id>")
    expect(output).toContain("mendcode mflow status")
    expect(output).toContain("mendcode worktree status|plan")
    expect(output).not.toContain("mendcode tui")
    expect(output).not.toContain("mendcode config")
    expect(output).not.toContain("adapter status")
    expect(output).not.toContain("export plan")
  })

  test("advanced help classifies tui as internal/debug-only", () => {
    const result = runPublicBin(["help", "advanced"])
    const output = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(output).toContain("Primary public surface")
    expect(output).toContain("Advanced/support surface")
    expect(output).toContain("Internal/debug-only surface")
    expect(output).toContain("tui")
    expect(output).toContain("install-source")
    expect(output).not.toContain("mendcode tui status|preview")
  })

  test("unknown root command suggests the closest MendCode command", () => {
    const result = runPublicBin(["statsu"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Unknown mendcode command: statsu")
    expect(output).toContain("Did you mean `mendcode status`?")
  })
})
