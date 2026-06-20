import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { activateTsm, deactivateTsm, removeTsm, tsmPlan, tsmStatePath, tsmStatus } from "../../src/mend/config/tsm"
import { createWorktreeRecord, planTsmWorktreeOpen } from "../../src/mend/worktree"

const previousBinary = process.env.MENDCODE_TSM_BINARY
const controlPlane = path.resolve(import.meta.dir, "../../src/mend/cli/control-plane.ts")

afterEach(() => {
  if (previousBinary === undefined) delete process.env.MENDCODE_TSM_BINARY
  else process.env.MENDCODE_TSM_BINARY = previousBinary
})

async function fakeTsm(root: string, version = "tsm v0.7.1") {
  const file = path.join(root, "bin", "tsm")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    `  echo ${JSON.stringify(version)}`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"wt\" ] && [ \"$2\" = \"--help\" ]; then",
    "  echo 'tsm wt add rm move prune open'",
    "  exit 0",
    "fi",
    "echo tsm fake",
  ].join("\n"))
  await chmod(file)
  return file
}

async function chmod(file: string) {
  await import("fs/promises").then((fs) => fs.chmod(file, 0o755))
}

describe("TSM lifecycle", () => {
  test("status is read-only and inactive when binary is absent", async () => {
    await using dir = await tmpdir({ git: true })
    process.env.MENDCODE_TSM_BINARY = path.join(dir.path, "missing-tsm")

    const status = await tsmStatus(dir.path)

    expect(status.lifecycle).toBe("not-installed")
    expect(status.enabled).toBe(false)
    expect(status.safety.installsTsm).toBe(false)
    expect(status.safety.killsSessions).toBe(false)
  })

  test("plan writes dry-run install guidance without activating TSM", async () => {
    await using dir = await tmpdir({ git: true })

    const plan = await tsmPlan(dir.path)
    const status = await tsmStatus(dir.path)

    expect(plan.status).toBe("dry-run")
    expect(plan.install.executesInstall).toBe(false)
    expect(plan.install.commands).toContain("brew tap adibhanna/tsm")
    expect(plan.install.commands).toContain("brew install adibhanna/tsm/tsm")
    expect(plan.install.commands.join("\n")).not.toContain("adibhanna/tap")
    expect(plan.activation.delegatesWorktreesImmediately).toBe(false)
    expect(status.enabled).toBe(false)
  })

  test("activate, deactivate, and remove only mutate MendCode scaffold", async () => {
    await using dir = await tmpdir({ git: true })
    process.env.MENDCODE_TSM_BINARY = await fakeTsm(dir.path)

    const active = await activateTsm(dir.path, { muxBackend: "cmux" })
    const stateText = await readFile(tsmStatePath(dir.path), "utf8")
    const inactive = await deactivateTsm(dir.path)
    const removed = await removeTsm(dir.path)

    expect(active.lifecycle).toBe("active")
    expect(active.binaryPath).toBe(process.env.MENDCODE_TSM_BINARY)
    expect(JSON.parse(stateText)).toMatchObject({ enabled: true, defaultMuxBackend: "cmux" })
    expect(inactive.lifecycle).toBe("installed-inactive")
    expect(removed.removesExternalTsm).toBe(false)
    expect(removed.killsSessions).toBe(false)
    expect(removed.status.lifecycle).toBe("installed-inactive")
  })

  test("control-plane TSM commands render text by default and JSON on request", async () => {
    await using dir = await tmpdir({ git: true })
    process.env.MENDCODE_TSM_BINARY = await fakeTsm(dir.path)
    const env = {
      ...process.env,
      MENDCODE_SHELL_CWD: dir.path,
    }

    const text = spawnSync("bun", [controlPlane, "tsm", "activate"], { env, encoding: "utf8" })
    const json = spawnSync("bun", [controlPlane, "tsm", "status", "--json"], { env, encoding: "utf8" })

    expect(text.status).toBe(0)
    expect(text.stdout.trim()).toStartWith("TSM: active")
    expect(text.stdout).toContain("Enabled: yes")
    expect(text.stdout.trim()).not.toStartWith("{")
    expect(json.status).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({ lifecycle: "active", enabled: true })
  })

  test("TSM executor plans through fake CLI without taking ownership gates", async () => {
    await using dir = await tmpdir({ git: true })
    process.env.MENDCODE_TSM_BINARY = await fakeTsm(dir.path)
    const record = createWorktreeRecord({
      creator: "mendcode",
      repoRoot: dir.path,
      path: path.join(dir.path, ".mendcode", "worktree", "demo"),
      branch: "mend/demo",
      baseRef: "main",
      executor: "native",
      sessions: [],
      packages: [],
      mflowMode: "off",
      creationPlan: { commands: [], writes: [] },
      cleanupPolicy: "remove-when-clean",
    })

    const inactive = await planTsmWorktreeOpen(record, dir.path)
    await activateTsm(dir.path)
    const active = await planTsmWorktreeOpen(record, dir.path)

    expect(inactive.allowed).toBe(false)
    expect(inactive.reasons).toContain("TSM integration is not active")
    expect(active.allowed).toBe(true)
    expect(active.preview.commands[0]).toMatchObject({ tool: "tsm", argv: ["wt", "mend/demo"], destructive: false })
  })

  test("linked worktrees read TSM activation from the base repo", async () => {
    await using dir = await tmpdir({ git: true })
    process.env.MENDCODE_TSM_BINARY = await fakeTsm(dir.path, "tsm v0.6.7")
    const linked = path.resolve(dir.path, "..", "linked-tsm-worktree")
    const add = spawnSync("git", ["worktree", "add", "-b", "mend/linked-tsm", linked, "HEAD"], {
      cwd: dir.path,
      encoding: "utf8",
    })
    try {
      expect(add.status).toBe(0)
      await activateTsm(dir.path)

      const fromLinked = await tsmStatus(linked)

      expect(fromLinked.lifecycle).toBe("active")
      expect(fromLinked.enabled).toBe(true)
      expect(fromLinked.workspace.isLinkedWorktree).toBe(true)
      expect(fromLinked.workspace.repoRoot).toBe(dir.path)
      expect(fromLinked.workspace.currentPath).toBe(linked)
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", linked], { cwd: dir.path, encoding: "utf8" })
      await rm(linked, { recursive: true, force: true })
    }
  })
})
