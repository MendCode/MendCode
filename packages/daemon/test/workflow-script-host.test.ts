import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { sandboxBackend } from "@mendcode/tools"
import type { ScriptHostPort } from "@mendcode/workflows"
import { createProcessScriptHost, outermostRoots, scriptBwrapArguments, scriptHostLaunch, scriptSeatbeltProfile, treeResidentKib } from "../src/workflow-script-host"

const temp = mkdtempSync(path.join(os.tmpdir(), "mc-script-host-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const sandboxed = sandboxBackend() !== undefined

type Outcome = { messages: Array<Record<string, unknown>>; exit?: string; ms: number }

/** Runs one script body in the real isolated process; answers its calls with `echo:<prompt>`. */
async function run(host: ScriptHostPort, body: string, waitMs = 8000): Promise<Outcome> {
  const started = Date.now()
  const messages: Array<Record<string, unknown>> = []
  let exit: string | undefined
  let done: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))
  const handle = host.start({
    workflowId: "workflow_test" as never,
    body,
    meta: { name: "t" },
    args: { a: 1 },
    seed: 7,
    now: 1_000,
    directory: temp,
    onMessage(message) {
      messages.push(message)
      if (message.t === "call") handle.send({ t: "reply", id: message.id, ok: true, value: `echo:${String(message.prompt ?? message.ms ?? "")}`, at: 2_000 })
      if (message.t === "done" || message.t === "error") done()
    },
    onExit(info) {
      exit = info.reason
      done()
    },
  })
  const timer = setTimeout(() => {
    handle.kill("test timeout")
    done()
  }, waitMs)
  await finished
  clearTimeout(timer)
  handle.kill("test over")
  return { messages, ...(exit ? { exit } : {}), ms: Date.now() - started }
}

const host = (limits = {}) => createProcessScriptHost({ dir: path.join(temp, "data"), limits: { pollMs: 200, ...limits } })
const result = (outcome: Outcome) => outcome.messages.find((message) => message.t === "done")?.result

describe("the isolated script host process", () => {
  test("a script talks to the daemon only through the API: call, reply, log, phase, return", async () => {
    const outcome = await run(host(), `phase("Go"); const answer = await agent("hello", { label: "x" }); log("got", answer); await sleep(5); return { answer, args, now: Date.now(), again: Date.now() === Date.now() }`)
    expect(outcome.messages.map((message) => message.t)).toEqual(["phase", "call", "log", "call", "done"])
    expect(result(outcome)).toEqual({ answer: "echo:hello", args: { a: 1 }, now: 2_000, again: true })
  }, 20_000)

  test("process, Bun, require, fetch, globalThis, dynamic code and import are not reachable", async () => {
    const probes: Record<string, string> = {
      globals: "return [typeof process, typeof Bun, typeof require, typeof fetch, typeof WebSocket, typeof Worker, typeof performance, typeof crypto, typeof Buffer]",
      globalThis: "return [typeof globalThis.process, Object.keys(globalThis).length, typeof self, typeof global]",
      thisIsEmpty: "return Object.getOwnPropertyNames(this).length",
      functionCtor: "try { return (function(){}).constructor('return process')() } catch (e) { return 'blocked' }",
      asyncCtor: "try { return await (async function(){}).constructor('return typeof process')() } catch (e) { return 'blocked' }",
      generatorCtor: "try { return Object.getPrototypeOf(function*(){}).constructor('return 1')().next() } catch (e) { return 'blocked' }",
      evalCall: "try { return eval('1 + 1') } catch (e) { return 'blocked' }",
      indirectEval: "try { return (0, eval)('typeof process') } catch (e) { return 'blocked' }",
      timers: "return [typeof setInterval, typeof setImmediate, typeof queueMicrotask]",
      realDate: "try { return new Date().getTime() === Date.now() } catch (e) { return 'err' }",
    }
    for (const [name, body] of Object.entries(probes)) {
      const outcome = await run(host(), body)
      const value = result(outcome)
      if (name === "globals") expect(value).toEqual(Array(9).fill("undefined"))
      else if (name === "globalThis") expect(value).toEqual(["undefined", 0, "object", "object"])
      else if (name === "thisIsEmpty") expect(value).toBe(0)
      else if (name === "timers") expect(value).toEqual(["undefined", "undefined", "undefined"])
      else if (name === "realDate") expect(value).toBe(true)
      else expect({ name, value }).toEqual({ name, value: "blocked" })
    }
  }, 60_000)

  test("import() and import.meta are refused before the script runs", async () => {
    for (const body of ["return await import('node:fs')", "return import.meta.url", "const f = `${import('x')}`; return f"]) {
      const outcome = await run(host(), body)
      expect(outcome.messages.find((message) => message.t === "error")?.message).toContain("import is not available")
    }
  }, 30_000)

  test("a loop that never yields is killed after the silence limit, and the daemon is told why", async () => {
    const outcome = await run(host({ silenceMs: 1_500 }), "while (true) {}", 15_000)
    expect(outcome.exit).toContain("no heartbeat")
    expect(outcome.ms).toBeLessThan(10_000)
  }, 30_000)

  test("a heap bomb is killed at the memory limit before it can take the machine down", async () => {
    const outcome = await run(host({ heapMb: 160, silenceMs: 25_000 }), "const keep = []; while (true) keep.push(new Array(1_000_000).fill(1))", 25_000)
    expect(outcome.exit).toContain("memory limit exceeded")
  }, 40_000)

  test("the memory of a script is measured on the whole process tree, because a sandbox wrapper such as bwrap is not the process that holds it", async () => {
    // bwrap (Linux) forks the sandbox's init, which forks the script host: the pid the daemon spawned is a few MB whatever the script does.
    const table = ["    1     0   9000", " 4000     1   2500", " 4001  4000   1800", " 4002  4001 900000", " 5000     1 700000", " 4003  4002    300"].join("\n")
    expect(treeResidentKib({ table, root: 4000 })).toBe(2500 + 1800 + 900000 + 300)
    expect(treeResidentKib({ table, root: 4002 })).toBe(900000 + 300)
    expect(treeResidentKib({ table, root: 6000 })).toBeUndefined()
    expect(treeResidentKib({ table: "garbage\n\n 1 2", root: 1 })).toBeUndefined()
    expect(treeResidentKib({ table: " 7 8 100\n 8 7 200", root: 7 })).toBe(300)
  })

  test("a heap bomb that lives below the process the daemon spawned is still killed at the limit", async () => {
    // The wrapper stays small and its child holds 300 MB for at most 20 s, as bubblewrap's script host does under the sandbox.
    const holder = path.join(temp, "holder.ts")
    writeFileSync(holder, "const keep = Buffer.alloc(300 * 1024 * 1024, 1)\nsetTimeout(() => process.exit(keep.length > 0 ? 0 : 1), 20_000)\nsetInterval(() => {}, 1000)\n")
    const wrapped = createProcessScriptHost({ dir: path.join(temp, "data"), backend: null, env: { MENDCODE_SCRIPT_UNSANDBOXED: "1" }, command: ["/bin/sh", "-c", `"${process.execPath}" "${holder}" & wait`], limits: { pollMs: 200, heapMb: 128, silenceMs: 25_000 } })
    const outcome = await run(wrapped, "", 15_000)
    expect(outcome.exit).toContain("memory limit exceeded")
    expect(outcome.ms).toBeLessThan(10_000)
  }, 30_000)

  test("a script that throws reports it; one that ends early is not mistaken for a crash", async () => {
    const thrown = await run(host(), "throw new TypeError('bad')")
    expect(thrown.messages.find((message) => message.t === "error")?.message).toBe("TypeError: bad")
    const bigInt = await run(host(), "return 10n")
    expect(bigInt.messages.find((message) => message.t === "error")?.message).toContain("not plain JSON")
  }, 30_000)
})

/**
 * The home listing a script sees. Seatbelt refuses it. bubblewrap shows an empty read-only tmpfs with only the mount points that lead
 * to the host's own files (the first directory below home of the executable, e.g. `.bun` when bun is installed there): nothing else.
 */
function expectHomeHidden(listing: string | undefined) {
  if (sandboxBackend()?.name === "seatbelt") return expect(listing).toBe("denied")
  const first = path.relative(os.homedir(), process.execPath).split(path.sep)[0]
  const leads = first && first !== ".." && !path.isAbsolute(first) ? [first] : []
  const visible = listing === "denied" ? [] : (listing ?? "?").split(",").filter(Boolean)
  for (const name of visible) expect({ name, allowed: leads, listing }).toMatchObject({ allowed: expect.arrayContaining([name]) })
}
/** Process creation and listening sockets are refused by Seatbelt only; bubblewrap has no syscall filter (the script host removes them at layer 3). */
const seatbeltOnly = sandboxBackend()?.name === "seatbelt" ? { spawn: "denied", listen: "denied" } : {}

describe.skipIf(!sandboxed)("the OS sandbox around the host", () => {
  const probe = path.join(temp, "probe.ts")
  writeFileSync(probe, `
    import { readFileSync, readdirSync, writeFileSync } from "node:fs"
    const out: Record<string, string> = {}
    const t = (name: string, fn: () => unknown) => { try { out[name] = String(fn()) } catch (e) { out[name] = "denied" } }
    t("readHome", () => readdirSync(${JSON.stringify(os.homedir())}).join(","))
    t("readData", () => readFileSync(${JSON.stringify(path.join(temp, "secret.txt"))}, "utf8"))
    t("write", () => writeFileSync(${JSON.stringify(path.join(os.homedir(), "mc-script-escape.txt"))}, "x"))
    t("writeTmp", () => writeFileSync(${JSON.stringify(path.join(temp, "escape.txt"))}, "x"))
    t("spawn",() => Bun.spawnSync(["/bin/echo", "hi"]).stdout)
    await fetch("http://127.0.0.1:9/").then(() => out.net = "reached", () => out.net = "denied")
    t("listen", () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }).port)
    process.stdout.write(JSON.stringify({ t: "done", result: out }) + "\\n")
  `)
  writeFileSync(path.join(temp, "secret.txt"), "top secret")

  test("even with every global reachable, the process cannot read home or data, write, reach the network or fork", async () => {
    const port = createProcessScriptHost({ dir: path.join(temp, "data"), command: [process.execPath, probe], readable: [probe], limits: { pollMs: 200 } })
    const outcome = await run(port, "", 15_000)
    const probed = result(outcome) as Record<string, string>
    expect({ probed, exit: outcome.exit }).toMatchObject({ probed: { readData: "denied", write: "denied", writeTmp: "denied", net: "denied", ...seatbeltOnly } })
    expectHomeHidden(probed.readHome)
  }, 30_000)
})

describe("a sandbox that does not start says how to check it", () => {
  const broken = (binary: string, name: "bwrap" | "seatbelt" = "bwrap") => createProcessScriptHost({ dir: path.join(temp, "data"), backend: { name, binary }, limits: { pollMs: 200 } })

  test("a missing sandbox binary fails the start with the hand check and the explicit way out", () => {
    const failing = broken("/nonexistent/bwrap")
    expect(() => failing.start({ workflowId: "workflow_test" as never, body: "return 1", meta: { name: "t" }, args: {}, seed: 1, now: 1, directory: temp, onMessage() {}, onExit() {} })).toThrow(/did not start the script host.*Check it by hand: \/nonexistent\/bwrap --unshare-user.*apparmor_restrict_unprivileged_userns.*not been verified on Linux.*MENDCODE_SCRIPT_UNSANDBOXED=1/)
  })

  test("a sandbox that starts and dies at once is reported with the same instructions, not as a script crash", async () => {
    const outcome = await run(broken("/usr/bin/false"), "return 1", 8_000)
    expect(outcome.exit).toContain("did not start the script host")
    expect(outcome.exit).toContain("Check it by hand: /usr/bin/false")
  }, 20_000)

  test("verify() runs a trivial command under the same wrapper: a working sandbox is undefined, a broken one explains itself, no sandbox is undefined", async () => {
    expect(await broken("/usr/bin/false").verify(temp)).toContain("Check it by hand")
    expect(await broken("/usr/bin/false", "seatbelt").verify(temp)).toContain("-p '(version 1)(allow default)'")
    expect(await createProcessScriptHost({ dir: path.join(temp, "data"), backend: null, env: { MENDCODE_SCRIPT_UNSANDBOXED: "1" } }).verify(temp)).toBeUndefined()
    if (sandboxed) expect(await createProcessScriptHost({ dir: path.join(temp, "data") }).verify(temp)).toBeUndefined()
  }, 20_000)
})

/**
 * The Linux profile, run for real. It is skipped everywhere but Linux; on Linux CI it must run (bubblewrap installed, unprivileged
 * user namespaces allowed) and fails loudly there when it cannot. The authors could not run it: it was written on macOS.
 */
describe.skipIf(process.platform !== "linux")("Linux bubblewrap (Linux CI only)", () => {
  const backend = sandboxBackend()
  const ready = backend?.name === "bwrap"
  const need = () => {
    if (ready) return true
    if (process.env.CI) throw new Error("Linux CI must provide bubblewrap (apt-get install bubblewrap) and allow unprivileged user namespaces; the bwrap profile is untested without it")
    return false
  }

  test("the sandbox starts here", async () => {
    if (!need()) return
    expect(await createProcessScriptHost({ dir: path.join(temp, "data") }).verify(temp)).toBeUndefined()
    expect(scriptHostLaunch({ dir: path.join(temp, "data"), directory: temp, env: {} }).isolation).toBe("bwrap")
  }, 20_000)

  test("a script runs through the API under bwrap, and a loop that never yields and a heap bomb are killed", async () => {
    if (!need()) return
    const outcome = await run(host(), `const answer = await agent("hello"); return { answer, now: Date.now() }`)
    expect(result(outcome)).toEqual({ answer: "echo:hello", now: 2_000 })
    const spinning = await run(host({ silenceMs: 1_500 }), "while (true) {}", 15_000)
    expect(spinning.exit).toContain("no heartbeat")
    const bomb = await run(host({ heapMb: 128 }), "const keep = []; for (;;) { keep.push(new Array(1_000_000).fill(1)); await sleep(0) }", 30_000)
    expect(bomb.exit).toContain("memory limit")
  }, 90_000)

  test("even with every global reachable, the process cannot read home or data, write, reach the network or fork", async () => {
    if (!need()) return
    const probe = path.join(temp, "probe-linux.ts")
    writeFileSync(probe, `
      import { readFileSync, readdirSync, writeFileSync } from "node:fs"
      const out: Record<string, string> = {}
      const t = (name: string, fn: () => unknown) => { try { out[name] = String(fn()) } catch (e) { out[name] = "denied" } }
      t("readHome", () => readdirSync(${JSON.stringify(os.homedir())}).join(","))
      t("readData", () => readFileSync(${JSON.stringify(path.join(temp, "secret.txt"))}, "utf8"))
      t("write", () => writeFileSync(${JSON.stringify(path.join(os.homedir(), "mc-script-escape.txt"))}, "x"))
      t("writeTmp", () => writeFileSync(${JSON.stringify(path.join(temp, "escape.txt"))}, "x"))
      await fetch("http://127.0.0.1:9/").then(() => out.net = "reached", () => out.net = "denied")
      process.stdout.write(JSON.stringify({ t: "done", result: out }) + "\\n")
    `)
    writeFileSync(path.join(temp, "secret.txt"), "top secret")
    const port = createProcessScriptHost({ dir: path.join(temp, "data"), command: [process.execPath, probe], readable: [probe], limits: { pollMs: 200 } })
    const probed = result(await run(port, "", 20_000)) as Record<string, string>
    expect(probed).toMatchObject({ readData: "denied", write: "denied", writeTmp: "denied", net: "denied" })
    expectHomeHidden(probed.readHome)
  }, 40_000)
})

describe("launch and profiles", () => {
  test("the Seatbelt profile denies writes, network, fork and reads of the hidden roots, then re-allows the host's own files", () => {
    const profile = scriptSeatbeltProfile({ hidden: ["/Users/x", "/data"], readable: ["/bin/bun"], readableTrees: ["/repo/packages/workflows/src"] })
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny process-fork)")
    expect(profile).toContain('(deny file-read-data (subpath "/Users/x") (subpath "/data"))')
    expect(profile.indexOf("(allow file-read-data")).toBeGreaterThan(profile.indexOf("(deny file-read-data"))
    expect(() => scriptSeatbeltProfile({ hidden: ["/a\nb"], readable: [], readableTrees: [] })).toThrow("control characters")
  })

  test("the bubblewrap arguments hide the roots, bind read-only, unshare the network and pids", () => {
    const args = scriptBwrapArguments({ hidden: ["/home/u", "/data"], readable: ["/home/u/.local/bin/mendcode"], exists: () => true })
    expect(args).toEqual(expect.arrayContaining(["--unshare-net", "--unshare-pid", "--ro-bind", "--die-with-parent"]))
    expect(args.join(" ")).toContain("--tmpfs /home/u")
    expect(args.join(" ").indexOf("--tmpfs /home/u")).toBeLessThan(args.join(" ").indexOf("--ro-bind /home/u/.local/bin/mendcode"))
  })

  test("a hidden root is read-only once the host's files are bound into it, and bubblewrap binds the extra files, not their directories", () => {
    const text = scriptBwrapArguments({ hidden: ["/home/u", "/tmp"], readable: ["/home/u/.local/bin/mendcode"], exists: () => true }).join(" ")
    for (const root of ["/home/u", "/tmp"]) expect(text.indexOf(`--remount-ro ${root}`)).toBeGreaterThan(text.indexOf("--ro-bind /home/u/.local/bin/mendcode"))
    const extra = path.join(temp, "extra-probe.ts")
    writeFileSync(extra, "")
    const launch = scriptHostLaunch({ dir: "/d", directory: "/p", home: "/home/u", backend: { name: "bwrap", binary: "/usr/bin/bwrap" }, command: ["/bin/true"], readable: [extra], env: {} })
    expect(launch.argv).toContain(extra)
    expect(launch.argv).not.toContain(path.dirname(extra))
    const seatbelt = scriptHostLaunch({ dir: "/d", directory: "/p", home: "/home/u", backend: { name: "seatbelt", binary: "/usr/bin/sandbox-exec" }, command: ["/bin/true"], readable: [extra], env: {} })
    expect(seatbelt.argv.join(" ")).toContain(`(literal "${path.dirname(realpathSync(extra))}")`)
  })

  /** Replays a bwrap argument list against a model of its mount table, as bwrap applies it: in order, a mount over a path buries what was mounted below it. */
  function replay(args: string[]) {
    const mounts = new Set<string>(["/"])
    const binds: Array<{ source: string; dest: string; readonly: boolean }> = []
    const tmpfs: string[] = []
    const remounted: string[] = []
    const problems: string[] = []
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === "--ro-bind" || flag === "--bind") {
        binds.push({ source: args[i + 1]!, dest: args[i + 2]!, readonly: flag === "--ro-bind" })
        mounts.add(args[i + 2]!)
        i += 2
      } else if (flag === "--tmpfs") {
        const root = args[++i]!
        for (const mount of [...mounts]) if (mount !== "/" && mount.startsWith(`${root}/`)) mounts.delete(mount)
        mounts.add(root)
        tmpfs.push(root)
      } else if (flag === "--remount-ro") {
        const root = args[++i]!
        if (!mounts.has(root)) problems.push(`--remount-ro ${root}: not a mount point at that moment`)
        remounted.push(root)
      } else if (flag === "--dev" || flag === "--proc" || flag === "--chdir") i++
    }
    return { binds, tmpfs, remounted, problems, mounts }
  }

  const linuxHidden = ["/home/runner", "/tmp/mc-script-host-x/data", "/tmp/mc-script-host-x", "/tmp", "/var/tmp"]

  test("bwrap arguments: every --remount-ro target is a live mount point, hidden roots are never nested, and only the listed files are bound", () => {
    const readable = ["/home/runner/.bun/bin/bun", "/tmp/mc-script-host-x/probe.ts", "/usr/bin/true"]
    const args = scriptBwrapArguments({ hidden: linuxHidden, readable, exists: () => true })
    const model = replay(args)
    expect(model.problems).toEqual([])
    // The CI failure: the per-run directory under /tmp was mounted first and then buried by the tmpfs on /tmp.
    expect(model.tmpfs).toEqual(["/home/runner", "/tmp", "/var/tmp"])
    expect(model.remounted.sort()).toEqual([...model.tmpfs].sort())
    // Every tmpfs is remounted read-only after the last bind into it, so a bound file can still be created inside.
    const lastBind = args.lastIndexOf("--ro-bind")
    for (const root of model.tmpfs) expect(args.indexOf("--remount-ro", args.indexOf(root))).toBeGreaterThan(lastBind)
    // Binds are read-only, of single files at their own path, and only for what lives under a hidden root (/usr is visible through the root bind).
    expect(model.binds.filter((bind) => bind.dest !== "/")).toEqual([
      { source: "/home/runner/.bun/bin/bun", dest: "/home/runner/.bun/bin/bun", readonly: true },
      { source: "/tmp/mc-script-host-x/probe.ts", dest: "/tmp/mc-script-host-x/probe.ts", readonly: true },
    ])
    expect(model.binds[0]).toEqual({ source: "/", dest: "/", readonly: true })
    // Home and the data directory are hidden and never bound.
    for (const secret of ["/home/runner", "/tmp/mc-script-host-x/data", "/tmp/mc-script-host-x"]) expect(model.binds.some((bind) => bind.source === secret || bind.dest === secret)).toBe(false)
    expect(args.indexOf("--chdir")).toBeGreaterThan(args.lastIndexOf("--remount-ro"))
  })

  test("bwrap arguments: hidden roots that do not exist are skipped, order and duplicates of the input do not matter, and a root with a trailing slash is the same root", () => {
    const shapes = [linuxHidden, [...linuxHidden].reverse(), [...linuxHidden, "/tmp", "/tmp/"], ["/tmp/", "/tmp/a/b", "/tmp/a"]]
    for (const hidden of shapes) {
      const model = replay(scriptBwrapArguments({ hidden, readable: ["/tmp/a/f"], exists: () => true }))
      expect(model.problems).toEqual([])
      expect(model.tmpfs.some((root, index) => model.tmpfs.some((other, at) => at !== index && (root === other || root.startsWith(`${other}/`))))).toBe(false)
    }
    expect(outermostRoots(["/a/b", "/a", "/c", "/ab", "/a/"])).toEqual(["/a", "/c", "/ab"])
    const sparse = scriptBwrapArguments({ hidden: linuxHidden, readable: [], exists: (file) => file === "/tmp" })
    expect(replay(sparse).tmpfs).toEqual(["/tmp"])
  })

  test("the launch of a real host never binds home, the data directory or a parent directory of an extra file", () => {
    const data = path.join(temp, "data-dir")
    const home = path.join(temp, "fake-home")
    for (const dir of [data, home]) writeFileSync(path.join(temp, path.basename(dir)), "")
    const extra = path.join(temp, "extra-two.ts")
    writeFileSync(extra, "")
    const launch = scriptHostLaunch({ dir: data, directory: temp, home, backend: { name: "bwrap", binary: "/usr/bin/bwrap" }, command: ["/bin/true"], readable: [extra], env: {} })
    const model = replay(launch.argv.slice(1, launch.argv.indexOf("--")))
    expect(model.problems).toEqual([])
    for (const bind of model.binds.filter((entry) => entry.dest !== "/")) {
      expect(bind.source).toBe(bind.dest)
      expect([data, home, temp, realpathSync(temp)]).not.toContain(bind.source)
    }
    expect(model.binds.map((bind) => bind.dest)).toContain(realpathSync(extra))
  })

  test("without an OS sandbox the host refuses to start, unless the user explicitly allows process isolation alone", () => {
    expect(() => scriptHostLaunch({ dir: "/d", directory: "/p", backend: null, env: {} })).toThrow("no OS sandbox")
    expect(scriptHostLaunch({ dir: "/d", directory: "/p", backend: null, env: { MENDCODE_SCRIPT_UNSANDBOXED: "1" } }).isolation).toBe("none")
    expect(scriptHostLaunch({ dir: "/d", directory: "/p", backend: { name: "seatbelt", binary: "/usr/bin/sandbox-exec" }, env: {} }).isolation).toBe("seatbelt")
  })
})
