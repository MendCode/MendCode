import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDaemonServiceCli, parseDaemonService, type DaemonServiceDeps } from "../apps/cli/src/daemon-service"
import { createUserService, type ServiceExecutor } from "../packages/daemon/src/user-service"
import { daemonLogPaths } from "../packages/daemon/src/daemon-logs"
import { appHarness, cleanTemps, conversation, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

/** Actual CLI factory with an isolated filesystem and a local fake OS manager; never installs a host service. */
export async function renderB68Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b68-frames-"))
  let running = false, loaded = false, output = "", activeTurns = 0
  const execute: ServiceExecutor = (command) => {
    if (command.includes("print")) return { code: loaded ? 0 : 1, stdout: loaded ? "state = running" : "", stderr: "" }
    if (command.includes("bootstrap")) { loaded = true; running = true }
    if (command.includes("bootout")) { loaded = false; running = false }
    return { code: 0, stdout: "", stderr: "" }
  }
  const host = createUserService({ dir, cwd: "/work/project", command: ["/opt/mendcode/bin/mendcode", "__daemon"], platform: "darwin", serviceDir: path.join(dir, "services") }, execute)
  const status = () => ({ running: true, pid: 42, dataDir: dir, engine: "faux", buildId: "b68-local-fake", activeTurns, backgroundJobs: 0, loops: { total: 2, active: 1, running: 0 }, dream: { configured: true, enabled: false, at: null, handled: null } })
  const deps: DaemonServiceDeps = {
    dir, cwd: "/work/project", host, now: Date.now, sleep: Bun.sleep, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } },
    connect: async () => running ? { close() {}, async send(command) {
      if (command.type === "daemon.shutdown") { running = false; return { ok: true } }
      if (command.type === "daemon.tick") return { ok: true, result: { scheduler: command.scheduler, execute: command.execute, due: [], started: [] } }
      return { ok: true, result: status() }
    } } : undefined,
    launch: async () => { running = true }, foreground: async () => { output += "Daemon: foreground\n" }, waitStopped: async () => {},
  }
  const reports = new Map<string, string>()
  const run = async (name: string, args: string[], expected = 0) => {
    output = ""
    const command = parseDaemonService(args)
    if (!command) throw new Error(`unrecognized B68 command ${name}`)
    const code = await createDaemonServiceCli(deps)(command)
    if (code !== expected) throw new Error(`${name}: exit ${code}\n${output}`)
    reports.set(name, output.replaceAll(dir, "/tmp/mend-service"))
  }
  try {
    await run("daemon-stopped", ["daemon", "status"])
    await run("service-plan", ["loops", "service", "plan"])
    await run("service-installed", ["control-plane", "memory", "dream", "service", "install"])
    await run("service-running", ["daemon", "service", "start"])
    await run("daemon-running", ["daemon", "status"])
    activeTurns = 1
    await run("daemon-busy", ["daemon", "service", "stop"], 1)
    activeTurns = 0
    await run("loops-once", ["control-plane", "loops", "daemon", "--once"])
    await run("dream-once", ["memory", "dream", "daemon", "--once", "--execute"])
    await run("service-restarted", ["daemon", "service", "restart"])
    writeFileSync(daemonLogPaths(dir).stdout, "{\"ready\":true,\"engine\":\"faux\"}\n")
    writeFileSync(daemonLogPaths(dir).stderr, "INFO local scheduler ready\n")
    await run("daemon-logs", ["daemon", "logs"])
    await run("service-stopped", ["daemon", "service", "stop"])
    await run("service-uninstalled", ["daemon", "service", "uninstall"])
    const originalHost = deps.host
    deps.host = createUserService({ dir, cwd: "/work/project", command: ["/opt/mendcode/bin/mendcode", "__daemon"], platform: "win32", serviceDir: path.join(dir, "windows") }, execute)
    await run("service-unsupported", ["daemon", "service", "install"], 1)
    deps.host = originalHost
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const [name, report] of reports) {
        const rows = wrap(report.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => fit([{ text: rows[page * height + row] ?? "" }], width).map((span) => span.text).join("")))
      }
      // The unchanged chat renderer displays a command report without adding a page or chrome.
      const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show daemon service health", reports.get("daemon-running")!)
      h.app.render()
      save("service-report-in-chat", h.frames.at(-1)!.map((row) => fit(row, width).map((span) => span.text).join("")))
      await h.app.onKey("\x03")
    }
  } finally { cleanTemps(); rmSync(dir, { recursive: true, force: true }) }
}
