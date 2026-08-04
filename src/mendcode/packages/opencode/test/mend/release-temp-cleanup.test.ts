import { describe, expect, test } from "bun:test"
import { access, chmod, mkdir, readFile, symlink, writeFile } from "fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const helper = path.resolve(import.meta.dir, "../../../../script/release-temp-cleanup.sh")
const releaseScript = path.resolve(import.meta.dir, "../../../../script/release")

async function exists(file: string) {
  return access(file).then(() => true, () => false)
}

async function fakeRelease(tempRoot: string, name = "release-v0.1.99-local") {
  const release = path.join(tempRoot, name, "src", "mendcode")
  await mkdir(path.join(release, "script"), { recursive: true })
  await writeFile(path.join(release, "script", "release"), "#!/usr/bin/env bash\n")
  await writeFile(path.join(release, "package.json"), JSON.stringify({ name: "mendcode-runtime" }))
  return release
}

function runHelper(script: string, env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bash", "-c", `source "$1"; ${script}`, "bash", helper],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("release temp cleanup", () => {
  test("removes only the armed release workspace node_modules under the temp root", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(tempRoot)
    const other = await fakeRelease(tempRoot, "other-workspace")
    await mkdir(path.join(release, "node_modules", "pkg"), { recursive: true })
    await mkdir(path.join(other, "node_modules", "pkg"), { recursive: true })

    const result = runHelper("mendcode_release_temp_cleanup_arm && mendcode_release_temp_cleanup", {
      MENDCODE_RELEASE_DIR: release,
      MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
    })

    expect(result.exitCode).toBe(0)
    expect(await exists(path.join(release, "node_modules"))).toBe(false)
    expect(await exists(path.join(other, "node_modules"))).toBe(true)
  })

  test("does not touch matching paths outside the configured temp root", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(path.join(tmp.path, "outside"))
    await mkdir(tempRoot, { recursive: true })
    await mkdir(path.join(release, "node_modules", "pkg"), { recursive: true })

    const result = runHelper("mendcode_release_temp_cleanup_arm && mendcode_release_temp_cleanup", {
      MENDCODE_RELEASE_DIR: release,
      MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
    })

    expect(result.exitCode).toBe(0)
    expect(await exists(path.join(release, "node_modules"))).toBe(true)
  })

  test("release entry cleans temp node_modules when workflow dispatch fails", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(tempRoot)
    const bin = path.join(tmp.path, "bin")
    const gh = path.join(bin, "gh")
    const log = path.join(tmp.path, "gh.log")
    await mkdir(path.join(release, "node_modules", "pkg"), { recursive: true })
    await mkdir(bin)
    await writeFile(gh, [`#!/bin/sh`, `printf '%s\\n' "$*" > ${JSON.stringify(log)}`, "exit 42", ""].join("\n"))
    await chmod(gh, 0o755)

    const result = Bun.spawnSync({
      cmd: ["bash", releaseScript],
      cwd: release,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MENDCODE_RELEASE_DIR: release,
        MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(42)
    expect(await readFile(log, "utf8")).toContain("workflow run publish.yml -f bump=patch")
    expect(await exists(path.join(release, "node_modules"))).toBe(false)
  })

  test("refuses an already active owned workspace marker", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(tempRoot)
    await mkdir(path.join(release, "node_modules", "pkg"), { recursive: true })
    await writeFile(path.join(tempRoot, "release-v0.1.99-local", ".mendcode-release-cleanup-owner"), [
      `pid=${process.pid}`,
      "token=other",
      "",
    ].join("\n"))

    const result = runHelper("mendcode_release_temp_cleanup_arm", {
      MENDCODE_RELEASE_DIR: release,
      MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("refusing active temp workspace")
    expect(await exists(path.join(release, "node_modules"))).toBe(true)
  })

  test("refuses a symlinked owner marker without modifying its target", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(tempRoot)
    const target = path.join(tmp.path, "owner-marker-target")
    await mkdir(path.join(release, "node_modules", "pkg"), { recursive: true })
    await writeFile(target, "keep me\n")
    await symlink(target, path.join(tempRoot, "release-v0.1.99-local", ".mendcode-release-cleanup-owner"))

    const result = runHelper("mendcode_release_temp_cleanup_arm", {
      MENDCODE_RELEASE_DIR: release,
      MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("refusing unsafe owner marker")
    expect(await readFile(target, "utf8")).toBe("keep me\n")
    expect(await exists(path.join(release, "node_modules"))).toBe(true)
  })

  test("refuses symlinked node_modules", async () => {
    await using tmp = await tmpdir()
    const tempRoot = path.join(tmp.path, "mendcode")
    const release = await fakeRelease(tempRoot)
    const target = path.join(tmp.path, "target-node-modules")
    await mkdir(target)
    await symlink(target, path.join(release, "node_modules"), "dir")

    const result = runHelper("mendcode_release_temp_cleanup_arm && mendcode_release_temp_cleanup", {
      MENDCODE_RELEASE_DIR: release,
      MENDCODE_RELEASE_TEMP_ROOT: tempRoot,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("refusing non-directory node_modules path")
    expect(await exists(target)).toBe(true)
  })
})
