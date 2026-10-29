import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isUpgradeCommand, parseUpgradeArgs, runUpgradeCommand, sha256Hex, UPGRADE_SCHEMA, type UpgradeCommandDeps } from "@mendcode/upgrade"
import { nodeFs } from "@mendcode/upgrade/io"

const cli = path.join(import.meta.dir, "..")
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const REPO = "acme/mendcode-test"
const encoder = new TextEncoder()
const asset = (tag: string, name: string) => `https://example.test/${tag}/${name}`

function harness(options: { env?: Record<string, string>; currentVersion?: string; tags?: string[] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-upgrade-cli-"))
  temps.push(dir)
  const tags = options.tags ?? ["v1.1.0"]
  const files = new Map<string, Uint8Array>()
  const releases = tags.map((tag) => {
    const body = `binary of ${tag}`
    const name = `mendcode-${tag.slice(1)}-linux-x64`
    files.set(asset(tag, name), encoder.encode(body))
    files.set(asset(tag, "SHA256SUMS"), encoder.encode(`${sha256Hex(encoder.encode(body))}  ${name}\n`))
    files.set(asset(tag, "release-index.json"), encoder.encode(JSON.stringify({ formatVersion: 1, repository: REPO, tag, channel: "stable", schema: { version: 1, fingerprint: "1".repeat(64) }, assets: [{ name, sha256: sha256Hex(encoder.encode(body)), size: encoder.encode(body).byteLength }] })))
    return { tag_name: tag, prerelease: false, published_at: "2026-01-01T00:00:00Z", assets: [name, "SHA256SUMS", "release-index.json", "provenance.sigstore.json"].map((name) => ({ name, browser_download_url: asset(tag, name) })) }
  })
  const calls: string[] = []
  let stdout = ""
  let stderr = ""
  const deps: UpgradeCommandDeps = {
    ports: {
      fetchJson: async (url) => {
        calls.push(url)
        return releases
      },
      download: async (url) => {
        calls.push(url)
        return files.get(url)!
      },
      fs: nodeFs,
      verifyProvenance: async () => {},
      now: () => 1_000,
    },
    out: { write: (text) => void (stdout += text) },
    err: { write: (text) => void (stderr += text) },
    env: { MENDCODE_UPGRADE_REPO: REPO, ...options.env },
    home: path.join(dir, "home"),
    defaultDir: path.join(dir, "default-data"),
    currentVersion: options.currentVersion ?? "1.0.0",
    platform: { os: "linux", arch: "x64" },
  }
  const run = async (...argv: string[]) => {
    const parsed = parseUpgradeArgs(["upgrade", ...argv])
    if (!parsed.ok) throw new Error(parsed.message)
    return runUpgradeCommand(parsed.command, deps)
  }
  return { dir, deps, calls, run, out: () => stdout, err: () => stderr }
}

describe("argument parsing", () => {
  test("defaults: no flags", () => {
    expect(parseUpgradeArgs(["upgrade"])).toEqual({ ok: true, command: { json: false, check: false, force: false, rollback: false, help: false } })
  })

  test("every flag, in either value spelling", () => {
    expect(parseUpgradeArgs(["upgrade", "--channel", "beta", "--check", "--json", "--dir", "/d"])).toEqual({ ok: true, command: { json: true, dir: "/d", channel: "beta", check: true, force: false, rollback: false, help: false } })
    expect(parseUpgradeArgs(["--dir=/d", "upgrade", "--channel=dev", "--force"])).toEqual({ ok: true, command: { json: false, dir: "/d", channel: "dev", check: false, force: true, rollback: false, help: false } })
    expect(parseUpgradeArgs(["upgrade", "--format", "json", "--rollback"])).toMatchObject({ ok: true, command: { json: true, rollback: true } })
  })

  test("rejects bad channels, unknown flags, missing values, extra words and contradictory flags", () => {
    const messages = [
      ["upgrade", "--channel", "edge"],
      ["upgrade", "--channel"],
      ["upgrade", "--channel", "--check"],
      ["upgrade", "--bogus"],
      ["upgrade", "now"],
      ["upgrade", "--check", "--force"],
      ["upgrade", "--rollback", "--check"],
      ["upgrade", "--rollback", "--channel", "beta"],
      ["upgrade", "--format", "xml"],
    ].map((argv) => parseUpgradeArgs(argv))
    for (const parsed of messages) expect(parsed.ok).toBe(false)
  })

  test("recognises the subcommand behind global flags and does not mistake a flag value for it", () => {
    expect(isUpgradeCommand(["upgrade"])).toBe(true)
    expect(isUpgradeCommand(["--dir", "/d", "upgrade", "--check"])).toBe(true)
    expect(isUpgradeCommand(["--dir=/d", "upgrade"])).toBe(true)
    expect(isUpgradeCommand(["--dir", "upgrade"])).toBe(false)
    expect(isUpgradeCommand(["run", "upgrade"])).toBe(false)
    expect(isUpgradeCommand(["export", "upgrade"])).toBe(false)
    expect(isUpgradeCommand([])).toBe(false)
  })
})

describe("upgrade --check", () => {
  test("reports an update in text, without writing or downloading anything", async () => {
    const box = harness()
    expect(await box.run("--check")).toBe(0)
    expect(box.out()).toContain("update available: 1.0.0 -> v1.1.0 (stable)")
    expect(box.calls).toHaveLength(1)
    expect(existsSync(box.deps.defaultDir)).toBe(false)
  })

  test("--json prints one schema-tagged result line", async () => {
    const box = harness()
    expect(await box.run("--check", "--json")).toBe(0)
    const lines = box.out().trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      schema: UPGRADE_SCHEMA,
      kind: "result",
      command: "upgrade",
      data: { status: "update-available", channel: "stable", current: "1.0.0", latest: "v1.1.0", downgrade: false, installedTo: null, asset: "mendcode-1.1.0-linux-x64", check: true },
    })
  })

  test("reports up to date and ahead", async () => {
    const same = harness({ currentVersion: "1.1.0" })
    await same.run("--check")
    expect(same.out()).toBe("up to date: 1.1.0 (stable)\n")
    const ahead = harness({ currentVersion: "1.4.0" })
    await ahead.run("--check")
    expect(ahead.out()).toContain("is newer than the newest stable release v1.1.0")
  })
})

describe("upgrade execution", () => {
  test("installs into the --dir data directory, tells the user to restart, and does not touch processes", async () => {
    const box = harness()
    const dataDir = path.join(box.dir, "explicit")
    expect(await box.run("--dir", dataDir)).toBe(0)
    expect(readFileSync(path.join(dataDir, "bin", "mendcode-next"), "utf8")).toBe("binary of v1.1.0")
    expect(box.out()).toContain("installed v1.1.0 (stable)")
    expect(box.out()).toContain("restart mendcode")
    expect(box.out()).toContain("--rollback")
    expect(readdirSync(box.dir).filter((name) => !name.startsWith("."))).toEqual(["explicit"])
  })

  test("the data directory follows MENDCODE_V2_DIR when --dir is absent, else the CLI default", async () => {
    const viaEnv = harness()
    viaEnv.deps.env.MENDCODE_V2_DIR = path.join(viaEnv.dir, "from-env")
    await viaEnv.run()
    expect(existsSync(path.join(viaEnv.dir, "from-env", "bin", "mendcode-next"))).toBe(true)
    const byDefault = harness()
    await byDefault.run()
    expect(existsSync(path.join(byDefault.deps.defaultDir, "bin", "mendcode-next"))).toBe(true)
  })

  test("--rollback goes back to the previous binary", async () => {
    const box = harness({ tags: ["v1.1.0"] })
    await box.run()
    box.deps.currentVersion = "1.1.0"
    await box.run("--force")
    expect(await box.run("--rollback")).toBe(0)
    expect(box.out()).toContain("rolled back")
  })

  test("failures print an error and exit 1; with --json they are a schema-tagged error line", async () => {
    const box = harness({ env: { MENDCODE_UPGRADE_REPO: "OWNER/mendcode" } })
    expect(await box.run()).toBe(1)
    expect(box.err()).toContain("error: [UPGRADE]: no release repository is configured")
    expect(box.calls).toEqual([])
    const json = harness({ env: { MENDCODE_UPGRADE_REPO: "OWNER/mendcode" } })
    expect(await json.run("--json")).toBe(1)
    expect(JSON.parse(json.out())).toMatchObject({ schema: UPGRADE_SCHEMA, kind: "error", command: "upgrade", error: { code: "repo-not-configured" } })
  })

  test("--help prints the usage and needs no network", async () => {
    const box = harness()
    expect(await box.run("--help")).toBe(0)
    expect(box.out()).toContain("usage: mendcode upgrade")
    expect(box.calls).toEqual([])
  })
})

describe("wiring", () => {
  test("apps/cli/src has no direct network or process spawning; the real ports live in packages/upgrade", async () => {
    const sources = [...new Bun.Glob("**/*.ts").scanSync({ cwd: path.join(cli, "src") })]
    for (const file of sources) {
      const source = await Bun.file(path.join(cli, "src", file)).text()
      expect(source.includes("fetch(") ? file : "").toBe("")
      expect(source.includes("Bun.spawn") ? file : "").toBe("")
    }
  })

  test("main.ts routes `upgrade` before connecting to a daemon and loads the package on demand", async () => {
    const source = await Bun.file(path.join(cli, "src/main.ts")).text()
    expect(source).toContain('await import("@mendcode/upgrade")')
    expect(source.indexOf("isUpgradeCommand")).toBeGreaterThan(0)
    expect(source.indexOf("isUpgradeCommand")).toBeLessThan(source.indexOf("await connect()"))
    expect(source.indexOf("isUpgradeCommand")).toBeLessThan(source.indexOf("await terminateDaemon("))
    expect(source).not.toMatch(/^import [^\n]*"@mendcode\/upgrade/m)
  })

  test("the upgrade package's module graph is free of zod and the protocol schemas", () => {
    const script = `await import("@mendcode/upgrade"); await import("@mendcode/upgrade/io");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ zod: keys.filter((k) => k.includes("/zod/")).length, protocol: keys.filter((k) => k.includes("/protocol/")).length }))`
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString().trim())).toEqual({ zod: 0, protocol: 0 })
  })

  test("B40 update alias uses the offline dispatcher and stays local-only with leading method flags", () => {
    const box = harness()
    const main = path.join(cli, "src/main.ts")
    const inspect = Bun.spawnSync(["bun", main, "--dir", box.dir, "update", "--inspect", "--json"], { stdout: "pipe", stderr: "pipe" })
    expect(inspect.exitCode).toBe(0)
    expect(inspect.stderr.toString()).toBe("")
    expect(JSON.parse(inspect.stdout.toString())).toMatchObject({ kind: "result", data: { channel: "stable", rollbackAvailable: false } })
    expect(readdirSync(box.dir)).toEqual([])
    const remote = Bun.spawnSync(["bun", main, "--dir", box.dir, "--socket", path.join(box.dir, "none.sock"), "--method", "direct", "update", "--inspect"], { stdout: "pipe", stderr: "pipe" })
    expect(remote.exitCode).toBe(64)
    expect(remote.stderr.toString()).toContain("local-only")
    expect(readdirSync(box.dir)).toEqual([])
  }, 20_000)
})
