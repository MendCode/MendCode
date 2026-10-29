import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createToolOutputs } from "../src/tool-output"
import { createSessionTranscripts } from "../src/session-transcripts"

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-output-security-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

for (const name of ["tool-output", "session-transcripts"] as const) {
  test(`${name} refuses a symlinked output directory on creation`, async () => {
    const dir = temp(), outside = temp()
    const service = name === "tool-output" ? createToolOutputs(dir) : createSessionTranscripts(dir)
    symlinkSync(outside, path.join(dir, name))
    const save = () => name === "tool-output"
      ? (service as ReturnType<typeof createToolOutputs>).save("private output")
      : (service as ReturnType<typeof createSessionTranscripts>).save({ sessionId: "s", generation: 1, markdown: "private transcript" })
    await expect(save()).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
  test(`${name} refuses an output directory replaced after an earlier save`, async () => {
    const dir = temp(), outside = temp()
    const service = name === "tool-output" ? createToolOutputs(dir) : createSessionTranscripts(dir)
    const save = () => name === "tool-output"
      ? (service as ReturnType<typeof createToolOutputs>).save("private output")
      : (service as ReturnType<typeof createSessionTranscripts>).save({ sessionId: "s", generation: 1, markdown: "private transcript" })
    await save()
    renameSync(path.join(dir, name), path.join(dir, `${name}-old`))
    symlinkSync(outside, path.join(dir, name))
    await expect(save()).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
}
