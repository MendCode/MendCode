import { expect, test } from "bun:test"
import { createTranscript } from "../src/view/transcript"
import { FRAME_GAP_MS, paced, pacedFrames } from "../src/ui/app/paced"
import { keepable } from "../src/ui/app/session-cache"
import { conversation, ids } from "./session-ui-harness"

test("a sub-agent whose window carries a full daemon page of tool output is still kept", () => {
  const transcript = createTranscript()
  const chat = conversation(ids("session"), (event) => transcript.apply(event))
  for (let n = 0; n < 8; n++) chat.exchange(`question ${n}`, "x".repeat(32_000))
  expect(keepable(transcript, 200)).toBe(true)
})

test("paced runs the first call at once and folds the calls of the gap into one that follows", async () => {
  let now = 0
  let runs = 0
  const ask = paced(() => void runs++, 40, () => now)
  ask()
  expect(runs).toBe(1)
  now = 10
  ask()
  ask()
  ask()
  expect(runs).toBe(1)
  await Bun.sleep(60)
  expect(runs).toBe(2)
  now = 200
  ask()
  expect(runs).toBe(3)
})

test("frames after a rest wait one short beat; frames in a stream are never closer than the gap", async () => {
  let now = 0
  const starts: number[] = []
  const schedule = pacedFrames(() => now)
  const frame = () => { starts.push(now) }
  schedule(frame)
  await Bun.sleep(25)
  expect(starts).toEqual([0])
  now = 5
  schedule(frame)
  await Bun.sleep(25)
  expect(starts).toEqual([0])
  await Bun.sleep(30)
  expect(starts.length).toBe(2)
  expect(FRAME_GAP_MS).toBeGreaterThanOrEqual(30)
})
