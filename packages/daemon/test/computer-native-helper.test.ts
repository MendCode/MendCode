import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNativeComputer } from "../src/computer-native"

// A stand-in helper in the place of the compiled one: nothing is compiled and no real application is touched.
// Like the real helper it waits in a blocking read that SIGTERM does not end, and cleans up when its input ends.
const STAND_IN = `#!/bin/bash
trap '' TERM
echo "$$" >> "$0.started"
while IFS= read -r line; do
  case "$line" in
    *'"method":"identify"'*'"pid":7'*) echo '{"ok":true,"value":{"pid":7,"bundleID":"local.editor","appName":"Editor"}}' ;;
    *'"method":"identify"'*'"pid":8'*) echo '{"ok":true,"value":{"pid":9,"bundleID":"local.editor","appName":"Editor"}}' ;;
    *'"method":"identify"'*) echo '{"ok":true,"value":null}' ;;
    *'"visible":true'*) echo '{"ok":true,"value":{"visible":true}}' ;;
    *) echo '{"ok":true,"value":{"visible":false}}' ;;
  esac
done
echo "$$" >> "$0.cleaned"
`

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function standIn() {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-native-"))
  dirs.push(dir)
  const source = await Bun.file(path.join(import.meta.dir, "../assets/computer.swift")).text()
  const hash = createHash("sha256").update(source).update(process.arch).digest("hex").slice(0, 20)
  const binary = path.join(dir, "computer-native", hash, "mendcode-computer")
  mkdirSync(path.dirname(binary), { recursive: true })
  writeFileSync(binary, STAND_IN)
  chmodSync(binary, 0o700)
  const lines = (file: string) => existsSync(file) ? (Bun.spawnSync(["/bin/cat", file]).stdout.toString().trim().split("\n").filter(Boolean)) : []
  return { dir, started: () => lines(`${binary}.started`), cleaned: () => lines(`${binary}.cleaned`) }
}

async function until(check: () => boolean, ms: number) {
  const began = Date.now()
  while (!check() && Date.now() - began < ms) await Bun.sleep(20)
  return Date.now() - began
}

test.skipIf(process.platform === "win32")("a cancelled action ends the idle helper through its input, so the cursor and the input lease go at once", async () => {
  const f = await standIn(), os = createNativeComputer(f.dir)
  try {
    const abort = new AbortController()
    await os.indicator(abort.signal, async () => { abort.abort() }).catch(() => {})
    // The forced end comes after 2 s and leaves no cleanup; the helper's own cleanup must come well before it.
    const waited = await until(() => f.cleaned().length === 1, 1500)
    expect(f.cleaned()).toHaveLength(1)
    expect(waited).toBeLessThan(1500)
  } finally { os.stop?.() }
})

test.skipIf(process.platform === "win32")("the next operation starts a new helper only after the cancelled one has ended", async () => {
  const f = await standIn(), os = createNativeComputer(f.dir)
  try {
    const abort = new AbortController()
    await os.indicator(abort.signal, async () => { abort.abort() }).catch(() => {})
    let cleanedBeforeNextAction = -1
    await os.indicator(new AbortController().signal, async () => { cleanedBeforeNextAction = f.cleaned().length })
    expect(cleanedBeforeNextAction).toBe(1)
    expect(f.started()).toHaveLength(2)
    expect(f.started()[0]).toBe(f.cleaned()[0]!)
  } finally { os.stop?.() }
})

test.skipIf(process.platform === "win32")("identify returns the approved process only: a helper answer for another process, or none, is not the target", async () => {
  const f = await standIn(), os = createNativeComputer(f.dir)
  try {
    const target = (pid: number) => ({ pid, bundleID: "local.editor", appName: "Editor" })
    expect(await os.identify(target(7), new AbortController().signal)).toEqual(target(7))
    expect(await os.identify(target(8), new AbortController().signal)).toBeUndefined()
    expect(await os.identify(target(5), new AbortController().signal)).toBeUndefined()
  } finally { os.stop?.() }
})
