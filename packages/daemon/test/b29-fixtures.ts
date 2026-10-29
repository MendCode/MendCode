import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type ComputerCaptureMetadata } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import type { CommandRunner, ToolResult } from "@mendcode/tools"
import { createComputerControl, type ComputerOptions } from "../src/computer"

export function png(width = 800, height = 500, extra = 0) {
  const bytes = Buffer.alloc(24 + extra)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

export function fakeComputer() {
  const calls: string[][] = []
  const keys: number[] = []
  const mac = { displays: 1, foreground: 42, processes: [] as number[], image: png(), resized: png(1600, 1000), failure: "", pause: undefined as (() => Promise<void>) | undefined, topology: undefined as string | undefined }
  const run: CommandRunner = async (args, signal) => {
    calls.push(args)
    if (mac.pause) await mac.pause()
    signal.throwIfAborted()
    if (mac.failure === args[0]) return { code: 1, stdout: "", stderr: "permission refused" }
    if (args[0] === "/usr/sbin/system_profiler") return { code: 0, stdout: mac.topology ?? JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: Array.from({ length: mac.displays }, () => ({})) }] }), stderr: "" }
    if (args[0] === "/usr/sbin/screencapture") writeFileSync(args.at(-1)!, mac.image)
    if (args[0] === "/usr/bin/sips") writeFileSync(args.at(-1)!, mac.resized)
    if (args[0] === "/usr/bin/osascript") {
      if (args[1] === "-l") return { code: 0, stdout: JSON.stringify({ pid: mac.foreground, bundleID: "local.editor", appName: "Local Editor" }), stderr: "" }
      if (args[2]?.includes("on run argv")) {
        if (Number(args[3]) !== mac.foreground) return { code: 1, stdout: "", stderr: "Foreground application changed" }
        keys.push(Number(args[4]))
      } else return { code: 0, stdout: String(mac.processes.shift() ?? mac.foreground), stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { mac, run, calls, keys }
}

export function computerFixture(options: ComputerOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b29-"))
  const store = openStore({ dir })
  const ids = createIdFactory()
  const sessionId = ids("session")
  const otherId = ids("session")
  store.createSession({ id: sessionId, directory: dir, title: "Computer" })
  store.createSession({ id: otherId, directory: dir, title: "Other" })
  const os = fakeComputer()
  let time = 1_800_000_000_000
  const control = createComputerControl(store, dir, { enabled: true, platform: "darwin", run: os.run, now: () => time, ...options })
  return { dir, store, sessionId, otherId, control, port: control.port(sessionId), os, advance: (ms: number) => { time += ms } }
}

export const captureData = (result: ToolResult): ComputerCaptureMetadata => JSON.parse(result.output)
export const signal = () => new AbortController().signal
