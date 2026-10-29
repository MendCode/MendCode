import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOutbox, MAX_HELD_NOTICES } from "../src/pr-review/outbox"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-outbox-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/** A session that takes a notice only while free, like the session actor with `idleOnly`. */
function session() {
  const taken: string[] = []
  const state = { busy: false, gone: false, throws: false }
  const notify = (_id: string, text: string) => {
    if (state.throws) throw new Error("actor closed")
    if (state.busy || state.gone) return undefined
    taken.push(text)
    return "que_1"
  }
  return { taken, state, notify }
}

function outbox(file: string, target: ReturnType<typeof session>) {
  const box = createOutbox({ file, notify: target.notify, sessionExists: () => !target.state.gone, retryMs: 3_600_000 })
  cleanups.push(() => box.stop())
  return box
}

describe("PR review outbox", () => {
  test("a free session gets each notice at once, one message per notice", async () => {
    const target = session()
    const box = outbox(path.join(temp(), "outbox.json"), target)
    await box.say("ses_a", "PR review of acme/app#1: reviewed")
    await box.say("ses_a", "PR review of acme/app#2: reviewed")
    expect(target.taken).toEqual(["PR review of acme/app#1: reviewed", "PR review of acme/app#2: reviewed"])
    expect(box.held("ses_a")).toEqual([])
  })

  test("notices refused while the session is busy are held in order and go as one message when it is idle", async () => {
    const target = session()
    const box = outbox(path.join(temp(), "outbox.json"), target)
    target.state.busy = true
    await box.say("ses_a", "first")
    await box.say("ses_a", "second")
    expect(target.taken).toEqual([])
    expect(box.held("ses_a")).toEqual(["first", "second"])
    // Offering again while still busy changes nothing.
    await box.flush("ses_a")
    expect(box.held("ses_a")).toEqual(["first", "second"])
    target.state.busy = false
    await box.flush("ses_a")
    expect(target.taken).toEqual(["2 PR review notices arrived while this session was busy:\n\nfirst\n\nsecond"])
    expect(box.held("ses_a")).toEqual([])
  })

  test("held notices survive a daemon restart", async () => {
    const file = path.join(temp(), "outbox.json")
    const target = session()
    target.state.busy = true
    const before = outbox(file, target)
    await before.say("ses_a", "@mendcode review from carol on acme/app#12 was not answered")
    before.stop()
    target.state.busy = false
    const after = outbox(file, target)
    expect(after.held("ses_a")).toEqual(["@mendcode review from carol on acme/app#12 was not answered"])
    await after.flushAll()
    expect(target.taken).toEqual(["@mendcode review from carol on acme/app#12 was not answered"])
  })

  test("a notice that throws stays held; a deleted session's notices are dropped; at most the newest are kept", async () => {
    const target = session()
    const box = outbox(path.join(temp(), "outbox.json"), target)
    target.state.throws = true
    await box.say("ses_a", "kept")
    expect(box.held("ses_a")).toEqual(["kept"])
    target.state.throws = false
    target.state.busy = true
    for (let index = 0; index < MAX_HELD_NOTICES + 5; index++) await box.say("ses_a", `n${index}`)
    expect(box.held("ses_a")).toHaveLength(MAX_HELD_NOTICES)
    expect(box.held("ses_a")[0]).toBe("n5")
    target.state.gone = true
    await box.flush("ses_a")
    expect(box.held("ses_a")).toEqual([])
    expect(target.taken).toEqual([])
  })
})
