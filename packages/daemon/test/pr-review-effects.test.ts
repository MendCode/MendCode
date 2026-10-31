import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { effectKey } from "../src/pr-review/contracts"
import { createEffectLedger } from "../src/pr-review/effects"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-review-effects-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const key = (payload: string, head = "a".repeat(40)) => effectKey({ kind: "review", repo: "acme/app", number: 12, reviewer: "global", configKey: "cfg1", head, base: "b".repeat(40), payload })

function effects({ dir = temp(), clock = { now: 1_000 }, retain }: { dir?: string; clock?: { now: number }; retain?: number } = {}) {
  const file = path.join(dir, "pr-review", "effects.json")
  return { ledger: createEffectLedger({ file, now: () => clock.now, ...(retain === undefined ? {} : { retain }) }), file, dir, clock }
}

describe("remote effects ledger", () => {
  test("an effect is recorded pending before it is sent; once done, intending the same key returns it unchanged so it is never sent twice", () => {
    const { ledger, file } = effects()
    const intent = ledger.intend({ kind: "review", key: key("p1"), jobId: "prj_1", marker: "<!-- mendcode:review a -->" })
    expect(intent).toMatchObject({ state: "pending", kind: "review", jobId: "prj_1" })
    expect(JSON.parse(readFileSync(file, "utf8")).effects).toHaveLength(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const sent = ledger.done(intent.id, "review:991")
    expect(sent).toMatchObject({ state: "done", remote: "review:991" })
    expect(ledger.intend({ kind: "review", key: key("p1") })).toEqual(sent)
    expect(ledger.done(intent.id, "other")).toEqual(sent)
    // Another head or payload is another effect.
    expect(ledger.intend({ kind: "review", key: key("p1", "c".repeat(40)) }).id).not.toBe(intent.id)
    expect(ledger.intend({ kind: "review", key: key("p2") }).id).not.toBe(intent.id)
  })

  test("a pending effect survives a restart (a crash or timeout right after the post): the same key returns it pending, for a remote check before any resend", () => {
    const first = effects()
    const intent = first.ledger.intend({ kind: "push", key: key("commit"), jobId: "prj_9" })
    const second = effects({ dir: first.dir, clock: first.clock })
    expect(second.ledger.pending().map((effect) => effect.id)).toEqual([intent.id])
    expect(second.ledger.intend({ kind: "push", key: key("commit") })).toMatchObject({ id: intent.id, state: "pending" })
    expect(second.ledger.byKey(key("commit"))!.id).toBe(intent.id)
    expect(second.ledger.ofJob("prj_9")).toHaveLength(1)
    // The reconciliation found the commit on the branch: done, no second push.
    second.ledger.done(intent.id, "c".repeat(40))
    expect(second.ledger.pending()).toEqual([])
  })

  test("an abandoned effect keeps its reason and is intended again under the same id; a done one cannot be abandoned", () => {
    const { ledger, clock } = effects()
    const intent = ledger.intend({ kind: "comment", key: key("reply") })
    expect(ledger.abandon(intent.id, "the head moved")).toMatchObject({ state: "abandoned", reason: "the head moved" })
    clock.now += 5
    const again = ledger.intend({ kind: "comment", key: key("reply") })
    expect(again).toMatchObject({ id: intent.id, state: "pending", updatedAt: clock.now })
    expect(again).not.toHaveProperty("reason")
    ledger.done(intent.id)
    expect(() => ledger.abandon(intent.id, "late")).toThrow(RangeError)
    expect(() => ledger.done("pre_missing")).toThrow(RangeError)
  })

  test("bounded at retain: finished effects go first, oldest first; pending ones stay while finished ones can make room", () => {
    const { ledger, clock, dir } = effects({ retain: 3 })
    const pending = ledger.intend({ kind: "review", key: key("keep") })
    for (const n of [1, 2, 3]) { clock.now += 1; const effect = ledger.intend({ kind: "review", key: key(`d${n}`) }); ledger.done(effect.id) }
    expect(effects({ dir, clock }).ledger.pending().map((effect) => effect.id)).toEqual([pending.id])
    expect(ledger.byKey(key("d1"))).toBeUndefined()
    expect(ledger.byKey(key("d3"))).toBeDefined()
    for (const n of [4, 5, 6]) { clock.now += 1; ledger.intend({ kind: "review", key: key(`p${n}`) }) }
    // Four pending for a bound of three: only then the oldest pending goes.
    expect(ledger.pending().map((effect) => effect.key)).toEqual([key("p4"), key("p5"), key("p6")])
  })

  test("a damaged effects file is kept aside and the ledger starts empty", () => {
    const { ledger, file, dir, clock } = effects()
    ledger.intend({ kind: "review", key: key("x") })
    writeFileSync(file, "[[[")
    const after = effects({ dir, clock })
    expect(after.ledger.pending()).toEqual([])
    expect(existsSync(`${file}.corrupt-${clock.now}`)).toBe(true)
  })
})
