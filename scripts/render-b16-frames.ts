import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { boot, stop, until } from "../packages/daemon/test/native-harness"
import { appHarness, cleanTemps, tempDir } from "../apps/cli/test/session-ui-harness"
import { createHeadlessRun } from "../apps/cli/src/run"
import { parseStartup, prepareStartup, prepareRunSubmission, STARTUP_USAGE } from "../apps/cli/src/startup"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB16Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const native = await boot({ steps: [[{ type: "reasoning", delta: "Check additive wire compatibility." }, ...stop("The command preserves the session transcript and uses the selected model.")]] })
  try {
    const scenes = new Map<string, string>([["startup-help", STARTUP_USAGE]])
    const options = parseStartup(["run", "Review the protocol", "--model", "gpt-6-sol", "--agent", "plan", "--variant", "high", "--title", "Protocol parity", "--thinking"])
    const selected = await prepareStartup(native.client, options, native.project, options.words.join(" "))
    const submission = await prepareRunSubmission(native.client, options, selected.sessionId, selected.directory, options.words.join(" "))
    let text = "", error = ""
    const run = createHeadlessRun({ client: native.client, sessionId: selected.sessionId, prompt: options.words.join(" "), thinking: true, json: false, approve: false, submit: () => native.client.send(submission), out: { write: (value: string) => { text += value } }, err: { write: (value: string) => { error += value } } })
    await native.client.subscribe(selected.sessionId, 0)
    const timer = setInterval(() => { for (const event of native.events.splice(0)) run.onEvent(event) }, 5)
    try { if (await run.start() !== 0) throw new Error(error) } finally { clearInterval(timer) }
    scenes.set("run-thinking", text)
    const fork = await prepareStartup(native.client, parseStartup(["--session", selected.sessionId, "--fork", "--title=Parity branch"]), native.project)
    const report = await native.client.diagnosticsResources()
    if (!report.ok) throw new Error(report.error.message)
    const memory = { rss: 42 * 1048576, heapTotal: 20 * 1048576, heapUsed: 10 * 1048576, external: 1048576, arrayBuffers: 0 }

    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, frame: string[]) => {
        if (frame.length !== height || frame.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid frame: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${frame.join("\n")}\n`)
      }
      for (const [name, content] of scenes) {
        const rows = wrap(content.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => (rows[page * height + row] ?? "").padEnd(width)))
      }
      const create = async (sessionId: SessionId, startup?: { prompt?: string; initialMessage?: string }) => {
        const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: native.project, ...(startup ? { startup } : {}), diagnostics: { memory: () => memory, snapshot: async () => "/tmp/mend-b16/diagnostics/tui.heapsnapshot" }, reply: (command) => command.type === "diagnostics.resources" ? { ok: true, result: report.report } : command.type === "diagnostics.snapshot" ? { ok: true, result: { path: "/tmp/mend-b16/diagnostics/daemon.heapsnapshot" } } : native.client.send(command), events: { loadWindow: (id) => native.client.loadWindow(id), loadBefore: (id, seq) => native.client.loadBefore(id, seq) } })
        h.app.applySettings({ onboarded: true })
        await h.app.start()
        return h
      }
      const frame = (h: ReturnType<typeof appHarness>, name: string) => { h.app.render(); save(name, h.frames.at(-1)!.map((row) => fit(row, width).map((span) => span.text).join(""))) }
      const draft = await create(selected.sessionId, { initialMessage: "Review wire compatibility\nPreserve unrelated work" })
      frame(draft, "startup-draft")
      const continued = await create(selected.sessionId)
      frame(continued, "startup-continued")
      const branched = await create(fork.sessionId)
      frame(branched, "startup-fork")
      native.steps.push(stop("Startup prompt received."))
      const autoSession = await prepareStartup(native.client, parseStartup([]), native.project)
      const automatic = await create(autoSession.sessionId, { prompt: "Review the startup contract" })
      await until(() => native.store.turns.list(autoSession.sessionId).some((turn) => turn.status === "completed"))
      await automatic.app.start()
      frame(automatic, "startup-prompt")
      continued.app.editor.replaceAll("")
      await continued.type("/diag\r")
      if (continued.app.page !== "diagnostics") throw new Error("diagnostics page did not open")
      frame(continued, "diagnostics")
      await continued.app.onKey("s")
      for (let page = 0; page < 8 && !continued.text().join("\n").includes("Heap snapshots"); page++) { await continued.app.onKey("\x1b[6~"); continued.app.render() }
      frame(continued, "diagnostics-snapshots")
      const broken = appHarness({ width, height, diagnostics: { memory: () => memory, snapshot: async () => "" }, reply: () => ({ ok: false, error: { code: "internal", message: "Daemon unavailable" } }) })
      await broken.type("/diag\r")
      frame(broken, "diagnostics-unavailable")
      const observer = appHarness({ width, height, remote: { host: "remote", readOnly: true }, diagnostics: { memory: () => memory, snapshot: async () => "" }, reply: () => ({ ok: true, result: report.report }) })
      await observer.type("/diag\r")
      frame(observer, "diagnostics-readonly")
      for (const h of [draft, continued, branched, automatic, broken, observer]) { await h.app.onKey("\x03"); await h.app.onKey("\x03") }
    }
  } finally { cleanTemps(); await native.cleanup() }
}
