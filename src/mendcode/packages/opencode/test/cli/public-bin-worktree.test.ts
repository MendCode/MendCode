import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { activateTsm } from "../../src/mend/config/tsm"
import { resolveWorktreeShortcutTarget, runtimeArgsForSessionShortcut, runtimeEnv } from "../../src/mend/cli/public-bin"
import { resolveCompiledRuntimeBinary } from "../../src/mend/runtime/system"

const publicBin = path.resolve(import.meta.dir, "../../src/mend/cli/public-bin.ts")
const previousBinary = process.env.MENDCODE_TSM_BINARY

afterEach(() => {
  if (previousBinary === undefined) delete process.env.MENDCODE_TSM_BINARY
  else process.env.MENDCODE_TSM_BINARY = previousBinary
})

function runPublicBin(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; bunBin?: string } = {},
) {
  return Bun.spawnSync({
    cmd: [options.bunBin || "bun", publicBin, ...args],
    cwd: options.cwd ?? import.meta.dir,
    env: {
      ...process.env,
      MENDCODE_ROOT: path.resolve(import.meta.dir, "../.."),
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function fakeTsm(root: string) {
  const file = path.join(root, "bin", "tsm")
  const log = path.join(root, "tsm.log")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(log)}`,
    "if [ \"$1\" = \"--version\" ]; then",
    "  echo 'tsm v0.6.7'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"wt\" ] && [ \"$2\" = \"--help\" ]; then",
    "  echo 'tsm wt add rm move prune open'",
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n"))
  await import("fs/promises").then((fs) => fs.chmod(file, 0o755))
  return { file, log }
}

async function fakeBun(root: string) {
  const file = path.join(root, "bin", "bun")
  const log = path.join(root, "bun.log")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" > ${JSON.stringify(log)}`,
    "exit 0",
  ].join("\n"))
  await import("fs/promises").then((fs) => fs.chmod(file, 0o755))
  return { file, log }
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
  test("does not leak the runtime project config directory into child runtimes", () => {
    const root = "/runtime/mendcode"
    const env = runtimeEnv(root, {
      MENDCODE_CONFIG_DIR: path.join(root, ".mendcode"),
      OPENCODE_CONFIG_DIR: path.join(root, ".mendcode"),
      MENDCODE_SHELL_CWD: "/workspace/project",
    })

    expect(env.MENDCODE_CONFIG_DIR).toBeUndefined()
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.MENDCODE_ROOT).toBe(root)
    expect(env.OPENCODE_CONFIG).toBe(path.join(root, ".mendcode", "generated", "opencode.json"))
  })

  test("selects a local compiled runtime while preserving a source-runtime escape hatch", async () => {
    await using tmp = await tmpdir()
    const platform = process.platform === "win32" ? "windows" : process.platform
    const binary = process.platform === "win32" ? "mendcode.exe" : "mendcode"
    const candidate = path.join(tmp.path, "dist", `mendcode-${platform}-${process.arch}`, "bin", binary)
    await mkdir(path.dirname(candidate), { recursive: true })
    await writeFile(candidate, "compiled")

    expect(resolveCompiledRuntimeBinary(tmp.path, {})).toBe(candidate)
    expect(resolveCompiledRuntimeBinary(tmp.path, { MENDCODE_USE_SOURCE_RUNTIME: "1" })).toBeUndefined()
  })

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

  test("resolves dot to the current worktree target", () => {
    const result = resolveWorktreeShortcutTarget(status({
      currentPath: "/repo",
      currentBranch: "crp",
      external: [{ path: "/repo", branch: "crp" }],
    }), ".")

    expect(result).toMatchObject({ path: "/repo", branch: "crp" })
  })

  test("uses the current base repo when it is the only branch-backed target", () => {
    const result = resolveWorktreeShortcutTarget(status({
      currentPath: "/repo",
      currentBranch: "crp",
      external: [{ path: "/repo", branch: "crp" }],
    }))

    expect(result).toMatchObject({ path: "/repo", branch: "crp" })
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

  test("--tsm creates an explicit missing branch through TSM before opening it", async () => {
    await using dir = await tmpdir({ git: true })
    const fake = await fakeTsm(dir.path)
    process.env.MENDCODE_TSM_BINARY = fake.file
    await activateTsm(dir.path)

    const result = runPublicBin(["--tsm", "glm"], {
      cwd: dir.path,
      env: {
        MENDCODE_TSM_BINARY: fake.file,
        PATH: `${path.dirname(fake.file)}:${process.env.PATH ?? ""}`,
      },
    })

    expect(result.exitCode).toBe(0)
    const calls = await readFile(fake.log, "utf8")
    expect(calls).toContain("wt add glm\n")
    expect(calls).toContain("wt open glm --split mendcode\n")
  })

  test("--tsm rejects explicit branch creation outside a git repository", async () => {
    await using dir = await tmpdir()
    const fake = await fakeTsm(dir.path)
    process.env.MENDCODE_TSM_BINARY = fake.file
    await activateTsm(dir.path)

    const result = runPublicBin(["--tsm", "glm"], {
      cwd: dir.path,
      env: {
        MENDCODE_TSM_BINARY: fake.file,
        PATH: `${path.dirname(fake.file)}:${process.env.PATH ?? ""}`,
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("TSM worktree shortcut requires a git repository")
    const calls = await readFile(fake.log, "utf8")
    expect(calls).not.toContain("wt add glm\n")
  })

  test("--tsm rejects explicit branch creation before the first commit", async () => {
    await using dir = await tmpdir({
      init: async (root) => {
        Bun.spawnSync({ cmd: ["git", "init"], cwd: root })
        Bun.spawnSync({ cmd: ["git", "config", "core.fsmonitor", "false"], cwd: root })
      },
    })
    const fake = await fakeTsm(dir.path)
    process.env.MENDCODE_TSM_BINARY = fake.file
    await activateTsm(dir.path)

    const result = runPublicBin(["--tsm", "glm"], {
      cwd: dir.path,
      env: {
        MENDCODE_TSM_BINARY: fake.file,
        PATH: `${path.dirname(fake.file)}:${process.env.PATH ?? ""}`,
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("requires an initial git commit")
    const calls = await readFile(fake.log, "utf8")
    expect(calls).not.toContain("wt add glm\n")
  })

  test("--worktree reports a clear error outside a git repository", async () => {
    await using dir = await tmpdir()

    const result = runPublicBin(["--worktree", "glm"], {
      cwd: dir.path,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("Worktree shortcut requires a git repository")
  })
})

describe("mend public CLI help", () => {
  test("--help emphasizes workflows and hides internal tui/config commands", () => {
    const result = runPublicBin(["--help"])
    const output = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(output).toContain("mendcode                         open MendCode")
    expect(output).toContain("mendcode marketplace status|list")
    expect(output).toContain("mendcode marketplace install <pack-id>")
    expect(output).toContain("mendcode install <pack-id>")
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

  test("install is a shortcut for marketplace install", async () => {
    await using dir = await tmpdir()
    const fake = await fakeBun(dir.path)

    const result = runPublicBin(["install", "sidequest", "official"], {
      cwd: dir.path,
      env: {
        MENDCODE_BUN_BIN: fake.file,
      },
    })

    expect(result.exitCode).toBe(0)
    const args = await readFile(fake.log, "utf8")
    expect(args).toContain("control-plane.ts marketplace install sidequest official")
  })
})

describe("mend public CLI session restore", () => {
  test("builds the -s session shortcut through the MendCode TUI runtime", async () => {
    await using dir = await tmpdir()

    expect(runtimeArgsForSessionShortcut("ses_0cd1e09f6ffePQGK5SRql5mfKz", dir.path)).toEqual([
      dir.path,
      "-s",
      "ses_0cd1e09f6ffePQGK5SRql5mfKz",
    ])
  })

  test("routes -s into the runtime session invocation", async () => {
    await using dir = await tmpdir()
    const fake = await fakeBun(dir.path)

    const result = runPublicBin(["-s", "ses_0cd1e09f6ffePQGK5SRql5mfKz"], {
      cwd: dir.path,
      bunBin: process.execPath,
      env: {
        MENDCODE_SHELL_CWD: dir.path,
        MENDCODE_USE_SOURCE_RUNTIME: "1",
        PATH: `${path.dirname(fake.file)}:${process.env.PATH ?? ""}`,
      },
    })

    expect(result.exitCode).toBe(0)
    const args = await readFile(fake.log, "utf8")
    expect(args).toContain("src/index.ts")
    expect(args).toContain(`${dir.path} -s ses_0cd1e09f6ffePQGK5SRql5mfKz`)
  })

  test("rejects the bare session id shortcut", () => {
    const result = runPublicBin(["ses_0cd1e09f6ffePQGK5SRql5mfKz"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Usage: mendcode -s ses_0cd1e09f6ffePQGK5SRql5mfKz")
    expect(output).toContain("Session shortcuts require the -s argument")
  })

  test("rejects extra arguments after -s", () => {
    const result = runPublicBin(["-s", "ses_0cd1e09f6ffePQGK5SRql5mfKz", "extra"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Usage: mendcode -s <session_id>")
  })

  test("rejects malformed session id shortcuts with a MendCode-owned error", () => {
    const result = runPublicBin(["ses_0cd1e09f6ffePQGK5SRql5mfKz-bad"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Invalid MendCode session id: ses_0cd1e09f6ffePQGK5SRql5mfKz-bad")
    expect(output).not.toContain("Blocked internal donor runtime command")
  })

  test("explains legacy donor session restores without exposing OpenCode as the public command", () => {
    const result = runPublicBin(["opencode", "--", "--session", "ses_0cd1e09f6ffePQGK5SRql5mfKz"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Blocked legacy session restore command")
    expect(output).toContain("Use: mendcode -s ses_0cd1e09f6ffePQGK5SRql5mfKz")
    expect(output).not.toContain("OpenCode is a donor/reference chassis")
  })

  test("keeps real donor commands blocked by default", () => {
    const result = runPublicBin(["opencode", "--", "session", "list"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Blocked internal donor runtime command: session")
    expect(output).toContain("MENDCODE_ALLOW_DONOR_COMMANDS=1")
  })

  test("does not misclassify donor session subcommands as legacy restores", () => {
    const result = runPublicBin(["opencode", "--", "session", "delete", "ses_0cd1e09f6ffePQGK5SRql5mfKz"])
    const output = result.stderr.toString()

    expect(result.exitCode).toBe(1)
    expect(output).toContain("Blocked internal donor runtime command: session")
    expect(output).not.toContain("Blocked legacy session restore command")
  })
})
