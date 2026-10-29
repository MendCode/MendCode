import { realpathSync } from "node:fs"
import { createPtyService } from "../packages/daemon/src/pty"

// Native OS evidence, separate from the fake-only test suite. Supply an existing temporary project.
const at = process.argv.indexOf("--dir")
if (at < 0 || !process.argv[at + 1]) throw new Error("usage: bun scripts/pty-canary.ts --dir TEMP_PROJECT")
const directory = realpathSync(process.argv[at + 1]!)
if (!directory.startsWith("/private/tmp/") && !directory.startsWith("/tmp/") && !directory.startsWith("/private/var/folders/")) throw new Error("PTY canary requires a temporary directory")
const service = createPtyService({ enabled: true }), scope = { directory }
const capture = () => {
  let text = "", cursor = 0, closed = 0
  return { socket: {
    send(data: string | Uint8Array) {
      if (typeof data === "string") { text += data; cursor += data.length }
      else cursor = JSON.parse(new TextDecoder().decode(data.subarray(1))).cursor
      return 1
    },
    close() { closed++ },
  }, text: () => text, cursor: () => cursor, closed: () => closed }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() > deadline) throw new Error("Native PTY canary deadline"); await Bun.sleep(5) }
}
try {
  const pty = service.create(scope, { command: "/bin/bash", args: ["--noprofile", "--norc"], env: { HISTFILE: "/dev/null", PS1: "", PROMPT_COMMAND: "" }, title: "Canary" })
  const first = capture(), connection = service.connect(scope, pty.id, first.socket)
  service.update(scope, pty.id, { size: { cols: 100, rows: 30 } })
  connection.message("stty -echo; test -t 0 && test -t 1 && printf '\\n__TTY_OK__\\n'; stty size; printf '\\n__UNICODE__🌿\\n'\n")
  await until(() => /(?:\r?\n)__UNICODE__🌿\r?\n/.test(first.text()))
  if (!/(?:\r?\n)__TTY_OK__\r?\n/.test(first.text()) || !/(?:\r?\n)30 100\r?\n/.test(first.text())) throw new Error("Native TTY or initial resize failed")
  const cursor = first.cursor()
  connection.close()
  const live = capture(), writer = service.connect(scope, pty.id, live.socket, -1)
  service.update(scope, pty.id, { size: { cols: 180, rows: 50 } })
  writer.message("printf '\\n__RECONNECT__\\n'; stty size\n")
  await until(() => /(?:\r?\n)50 180\r?\n/.test(live.text()))
  const resumed = capture()
  service.connect(scope, pty.id, resumed.socket, cursor)
  if (!resumed.text().includes("__RECONNECT__") || resumed.text().includes("__TTY_OK__") || resumed.cursor() !== cursor + resumed.text().length) throw new Error("Native cursor replay failed")
  service.remove(scope, pty.id)
  if (service.list(scope).length || !resumed.closed()) throw new Error("Native PTY cleanup failed")
  await until(() => { try { process.kill(pty.pid, 0); return false } catch { return true } })
  const exiting = service.create(scope, { command: "/bin/bash", args: ["--noprofile", "--norc"], env: { HISTFILE: "/dev/null", PS1: "", PROMPT_COMMAND: "" } })
  const final = capture(), exitConnection = service.connect(scope, exiting.id, final.socket)
  exitConnection.message("stty -echo; printf '\\n__NATIVE_EXIT__\\n'; exit\n")
  await until(() => service.list(scope).length === 0)
  if (!/(?:\r?\n)__NATIVE_EXIT__\r?\n/.test(final.text()) || !final.closed()) throw new Error("Native exit lost final output")
  process.stdout.write(JSON.stringify({ platform: process.platform, nativeTTY: true, unicode: true, resize: ["100x30", "180x50"], reconnectCursor: true, remove: true, processReaped: true, naturalExit: true }) + "\n")
} finally { service.dispose() }
