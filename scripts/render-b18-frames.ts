import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, tempDir } from "../apps/cli/test/session-ui-harness"
import { boot, answer, openSession, say } from "../packages/daemon/test/native-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB18Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const native = await boot({ steps: [answer("The runtime uses an additive socket protocol.", { input: 2400, output: 60 })] })
  try {
    const sessionId = await openSession(native)
    await say(native, sessionId, "Inspect protocol compatibility")
    const reports = new Map<string, string>()
    for (const [name, args] of [
      ["context-cli", ["context", sessionId, "--limit", "20"]],
      ["system-status", ["control-plane", "system", "status"]],
      ["system-doctor", ["control-plane", "system", "doctor"]],
      ["system-check", ["control-plane", "system", "check"]],
      ["system-toolchain", ["control-plane", "system", "toolchain"]],
      ["system-config-paths", ["control-plane", "system", "config-paths"]],
      ["system-adapter-status", ["control-plane", "system", "adapter-status"]],
      ["ai-env", ["control-plane", "ai", "env", "status"]],
      ["ai-status", ["control-plane", "ai", "status"]],
    ] as const) {
      const parsed = parseAutomation([...args])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps = { client: native.client, cwd: native.project, out: { write: (text: string) => { output += text } }, err: { write: (text: string) => { output += text } }, now: () => Date.now(), listen: () => {}, onInterrupt: () => {} } as AutomationDeps
      if (await runAutomation(parsed.command, deps) !== 0) throw new Error(output)
      reports.set(name, output)
    }
    const resources = await native.client.diagnosticsResources()
    if (!resources.ok) throw new Error(resources.error.message)
    const memory = { rss: 42 * 1048576, heapTotal: 20 * 1048576, heapUsed: 10 * 1048576, external: 1048576, arrayBuffers: 0 }
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = wrap(output.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => fit([{ text: rows[page * height + row] ?? "" }], width).map((span) => span.text).join("")))
      }
      for (const broken of [false, true]) {
        const h = appHarness({ width, height, dataDir: tempDir(), diagnostics: { memory: () => memory, snapshot: async () => "/tmp/mend-data/diagnostics/tui.heapsnapshot" }, reply: (command) => command.type === "diagnostics.resources" ? broken ? { ok: false, error: { code: "internal", message: "Daemon unavailable" } } : { ok: true, result: resources.report } : command.type === "diagnostics.snapshot" ? { ok: true, result: { path: "/tmp/mend-data/diagnostics/daemon.heapsnapshot" } } : undefined })
        conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Inspect current runtime", "The report samples memory and loaded resources on demand.")
        const frame = (name: string) => { h.app.render(); save(name, h.frames.at(-1)!.map((row) => fit(row, width).map((span) => span.text).join(""))) }
        await h.type("/diagnostics\r")
        frame(broken ? "diagnostics-error" : "diagnostics")
        if (!broken) {
          await h.app.onKey("s")
          for (let page = 0; page < 6 && !h.text().join("\n").includes("Heap snapshots"); page++) { await h.app.onKey("\x1b[6~"); h.app.render() }
          frame("diagnostics-snapshots")
        }
        await h.app.onKey("\x03")
      }
    }
  } finally { cleanTemps(); await native.cleanup() }
}
