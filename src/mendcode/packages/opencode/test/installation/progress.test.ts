import { expect, test } from "bun:test"
import { updateLabel, updateProgress, type UpdatePhase, type DownloadProgress } from "../../src/installation/progress"

test("streams phases across chunk boundaries and never treats installer output as readiness", () => {
  const phases: UpdatePhase[] = []
  const consume = updateProgress((phase) => phases.push(phase))
  consume("download log\nMENDCODE_UPDATE_PHA")
  consume("SE=downloading\nMENDCODE_UPDATE_PHASE=downloading\n")
  consume("MENDCODE_UPDATE_PHASE=ready\nMENDCODE_UPDATE_PHASE=verifying\n")
  consume("MENDCODE_UPDATE_PHASE=activated\n")
  expect(phases).toEqual(["downloading", "verifying", "activated"])
})

test("a broken progress observer cannot interrupt activation", () => {
  const consume = updateProgress(() => { throw new Error("observer unavailable") })
  expect(() => consume("MENDCODE_UPDATE_PHASE=activating\n")).not.toThrow()
})

test("download bytes are bounded, monotonic and only accepted while downloading", () => {
  const updates: DownloadProgress[] = []
  const consume = updateProgress((_, progress) => { if (progress) updates.push(progress) })
  consume("MENDCODE_UPDATE_BYTES=1/2\nMENDCODE_UPDATE_PHASE=downloading\nMENDCODE_UPDATE_BYTES=1048576/")
  consume("2097152\nMENDCODE_UPDATE_BYTES=1/2\nMENDCODE_UPDATE_BYTES=1048576/2097152\n")
  consume("MENDCODE_UPDATE_BYTES=999999999999999999999/\nMENDCODE_UPDATE_BYTES=2097152/1\n")
  consume("MENDCODE_UPDATE_BYTES=2097152/\nMENDCODE_UPDATE_PHASE=verifying\nMENDCODE_UPDATE_BYTES=4194304/\n")
  expect(updates).toEqual([{ bytes: 1048576, total: 2097152 }, { bytes: 2097152, total: undefined }])
  expect(updateLabel("downloading", updates[0])).toBe("Downloading · 1.0 MiB / 2.0 MiB (50%)")
  expect(updateLabel("downloading", updates[1])).toBe("Downloading · 2.0 MiB")
})
