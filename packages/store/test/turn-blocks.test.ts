import { describe, expect, test } from "bun:test"
import { decodeTurnBlock, encodeTurnBlock, isTurnBlock } from "../src/turn-blocks"

const turn = [
  { seq: 6, type: "turn.started", at: 1793671856000, payload: '{"turnId":"trn_01M6FJRVYR3JM7V4","queueId":"que_01M6FJRVYBXAGGMM"}' },
  { seq: 7, type: "item.started", at: 1793671856004, payload: '{"turnId":"trn_01M6FJRVYR3JM7V4","itemId":"itm_01M6FJRVYWJEE7GP","kind":"user_message"}' },
  { seq: 8, type: "item.completed", at: 1793671856004, payload: '{"itemId":"itm_01M6FJRVYWJEE7GP","status":"ok","text":"read colors.css — ñandú 🎨"}' },
  { seq: 10, type: "usage.recorded", at: 1793671857200, payload: '{"turnId":"trn_01M6FJRVYR3JM7V4","provider":"chatgpt","input":6834,"profile":[5132,0,59,0,2938,0,8129,3882,3906,16,0]}' },
  { seq: 83, type: "item.completed", at: 1793671859000, payload: '{"itemId":"itm_01M6FJS46ZDW3A6K","status":"ok","text":"line\\n\\ttab \\"quoted\\""}' },
  { seq: 85, type: "turn.completed", at: 1793671859001, payload: '{"turnId":"trn_01M6FJRVYR3JM7V4"}' },
]

describe("turn blocks", () => {
  test("a sealed turn decodes to rows byte-identical to the stored ones, gaps in the sequence included", () => {
    const block = encodeTurnBlock(turn)
    expect(isTurnBlock(block)).toBe(true)
    expect(decodeTurnBlock(block)).toEqual(turn)
  })

  test("a block is smaller than the rows it replaces", () => {
    const stored = turn.reduce((sum, row) => sum + Buffer.byteLength(row.payload) + row.type.length + 16, 0)
    expect(encodeTurnBlock(turn).byteLength).toBeLessThan(stored)
  })

  test("a legacy payload that still carries its envelope and a clock that stepped back both survive", () => {
    const rows = [
      { seq: 1, type: "session.created", at: 2000, payload: '{"sessionId":"ses_X","seq":1,"at":2000,"type":"session.created","directory":"/tmp"}' },
      { seq: 2, type: "foreground.state", at: 1500, payload: '{"state":"idle"}' },
      { seq: 3, type: "foreground.state", at: 1500, payload: "{}" },
    ]
    expect(decodeTurnBlock(encodeTurnBlock(rows))).toEqual(rows)
  })

  test("an empty turn round-trips", () => {
    expect(decodeTurnBlock(encodeTurnBlock([]))).toEqual([])
  })

  test("rows out of sequence order are refused instead of stored wrong", () => {
    expect(() => encodeTurnBlock([turn[1]!, turn[0]!])).toThrow(RangeError)
  })

  test("anything that is not a block, or a newer block version, is refused", () => {
    expect(() => decodeTurnBlock(new TextEncoder().encode('{"itemId":"x"}'))).toThrow(TypeError)
    const newer = encodeTurnBlock(turn)
    newer[4] = 2
    expect(() => decodeTurnBlock(newer)).toThrow(RangeError)
  })
})
