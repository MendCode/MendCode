import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { bareTerminal, chooseRemote, parseProfileCommand, parseRemoteProfiles, runProfileCommand, type RemoteProbes } from "../src/remote-profiles"
import { parseRemoteFlags } from "../src/remote"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-remotes-")); dirs.push(dir); return dir }
const out = () => { const lines: string[] = []; return { write: (text: string) => void lines.push(text), lines } }
const probes = (input: { reachable?: boolean; local?: boolean } = {}): RemoteProbes & { asked: string[] } => {
  const asked: string[] = []
  return { asked, reachable: async (address) => { asked.push(`reach ${address}`); return input.reachable ?? true }, localUp: async () => { asked.push("local"); return input.local ?? false } }
}
const saved = (dir: string, value: unknown) => writeFileSync(path.join(dir, "remotes.json"), JSON.stringify(value))
const PROFILES = { defaultRemote: "vps", remotes: { vps: { connect: "vps.example:9876", tokenFile: "/t/vps", ca: "/t/ca.pem" }, lab: { connect: "10.0.0.2:9876" } } }

test("remotes.json is strict: unknown keys, bad names, bad addresses and a default that is not saved are refused", () => {
  expect(parseRemoteProfiles(JSON.stringify(PROFILES)).defaultRemote).toBe("vps")
  for (const bad of [{ remotes: { "a b": { connect: "h:1" } } }, { remotes: { a: { connect: "nohost" } } }, { remotes: { a: { connect: "h:0" } } }, { remotes: { a: { connect: "h:1", token: "secret" } } }, { defaultRemote: "x", remotes: {} }, { remotes: {}, extra: 1 }, { fallback: "sometimes", remotes: {} }]) expect(() => parseRemoteProfiles(JSON.stringify(bad))).toThrow("invalid remotes.json")
  expect(() => parseRemoteProfiles("{")).toThrow("invalid remotes.json")
})

test("remote add/list/default/remove write a private file that holds paths, never a token", () => {
  const dir = temp()
  const run = (...argv: string[]) => { const o = out(); runProfileCommand(parseProfileCommand(["remote", ...argv, "--dir", dir], dir)!, o); return o.lines.join("") }
  expect(run("add", "vps", "vps.example:9876", "--token-file", "/t/vps", "--default", "--local-first")).toBe("saved\n")
  expect(statSync(path.join(dir, "remotes.json")).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ defaultRemote: "vps", fallback: "local-first", remotes: { vps: { connect: "vps.example:9876", tokenFile: "/t/vps" } } })
  expect(run("list")).toBe("vps (default)\tvps.example:9876\ttoken file\n")
  expect(run("default")).toBe("vps local-first\n")
  run("default", "none", "--remote-first")
  expect(run("list")).toBe("vps\tvps.example:9876\ttoken file\n")
  expect(() => run("default", "ghost")).toThrow("no saved remote ghost")
  expect(() => run("add", "bad name", "h:1")).toThrow()
  run("remove", "vps")
  expect(run("list")).toBe("")
  expect(() => run("remove", "vps")).toThrow("no saved remote")
  expect(parseProfileCommand(["remote", "token", "create", "--dir", dir], dir)).toBeUndefined()
  expect(parseProfileCommand(["session", "list"], dir)).toBeUndefined()
})

test("--remote NAME turns into the transport flags the existing parser takes", async () => {
  const dir = temp()
  saved(dir, PROFILES)
  const p = probes()
  const choice = await chooseRemote({ args: ["--remote", "vps", "--session", "S1"], dir, probes: p })
  expect(choice.args).toEqual(["--session", "S1", "--connect", "vps.example:9876", "--token-file", "/t/vps", "--ca", "/t/ca.pem"])
  expect(p.asked).toEqual([])
  const flags = parseRemoteFlags(choice.args)
  expect(flags.remote).toMatchObject({ hostname: "vps.example", port: 9876, tls: true, tokenFile: "/t/vps", caFile: "/t/ca.pem" })
  expect((await chooseRemote({ args: ["--remote=lab"], dir, probes: p })).args).toEqual(["--connect", "10.0.0.2:9876"])
  await expect(chooseRemote({ args: ["--remote", "ghost"], dir, probes: p })).rejects.toThrow("no saved remote ghost")
  await expect(chooseRemote({ args: ["--remote", "vps", "--connect", "h:1"], dir, probes: p })).rejects.toThrow("cannot be combined")
  await expect(chooseRemote({ args: ["--remote", "vps", "--local"], dir, probes: p })).rejects.toThrow("not both")
})

test("the default remote applies to a bare terminal start only, and --local or an explicit transport skips it", async () => {
  const dir = temp()
  saved(dir, PROFILES)
  const p = probes({ reachable: true })
  expect((await chooseRemote({ args: [], dir, probes: p })).args).toContain("--connect")
  expect((await chooseRemote({ args: ["--session", "S1"], dir, probes: p })).args).toContain("--connect")
  for (const args of [["daemon", "status"], ["session", "list"], ["run", "hello"], ["docs"]]) expect((await chooseRemote({ args, dir, probes: p })).args).toEqual(args)
  expect((await chooseRemote({ args: ["--local"], dir, probes: p })).args).toEqual([])
  expect((await chooseRemote({ args: ["--connect", "h:1"], dir, probes: p })).args).toEqual(["--connect", "h:1"])
  expect((await chooseRemote({ args: ["--socket", "/tmp/s.sock"], dir, probes: p })).args).toEqual(["--socket", "/tmp/s.sock"])
  expect(bareTerminal(["--session", "S1"])).toBe(true)
  expect(bareTerminal(["--unknown", "value"])).toBe(false)
})

test("remote-first falls back to this machine with a note; local-first prefers a running local daemon", async () => {
  const dir = temp()
  saved(dir, PROFILES)
  const down = probes({ reachable: false })
  expect(await chooseRemote({ args: [], dir, probes: down })).toEqual({ args: [], note: "remote vps is not reachable; using this machine" })
  saved(dir, { ...PROFILES, fallback: "local-first" })
  const running = probes({ local: true })
  expect((await chooseRemote({ args: [], dir, probes: running })).args).toEqual([])
  expect(running.asked).toEqual(["local"])
  const idle = probes({ local: false, reachable: true })
  expect((await chooseRemote({ args: [], dir, probes: idle })).args).toContain("--connect")
  expect(idle.asked).toEqual(["local", "reach vps.example:9876"])
  // An explicit --remote never falls back silently.
  expect((await chooseRemote({ args: ["--remote", "vps"], dir, probes: down })).args).toContain("--connect")
})

test("with no remotes.json nothing changes and --remote reports it", async () => {
  const dir = temp()
  const p = probes()
  expect(await chooseRemote({ args: [], dir, probes: p })).toEqual({ args: [] })
  await expect(chooseRemote({ args: ["--remote", "vps"], dir, probes: p })).rejects.toThrow("no saved remote vps")
  expect(p.asked).toEqual([])
})
