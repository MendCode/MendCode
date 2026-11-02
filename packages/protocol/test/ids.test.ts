import { describe, expect, test } from "bun:test"
import { createIdFactory, ItemId, SessionId, TurnId } from "../src/ids"

describe("ids", () => {
  test("new ids are the prefix, 10 time characters and 6 random ones", () => {
    const next = createIdFactory({ now: () => 1_793_644_776_134 })
    const id = next("session")
    expect(id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{16}$/)
    expect(SessionId.safeParse(id).success).toBe(true)
  })

  test("ids written with the older 16-character random tail still validate", () => {
    expect(SessionId.safeParse("ses_01M6ERY9YX5SRC7DADYF6CD7MF").success).toBe(true)
    expect(TurnId.safeParse("trn_01M6ERYA2D9XZZKQKXZQVPCN7K").success).toBe(true)
    expect(ItemId.safeParse("itm_01M606KX5HFRJ1VBXKBT9D5FZR").success).toBe(true)
  })

  test("other lengths, prefixes and characters are rejected", () => {
    for (const bad of ["ses_01M6ERY9YX5SRC7", "ses_01M6ERY9YX5SRC7DADYF", "trn_01M6ERY9YX5SRC7D", "ses_01M6ERY9YX5SRC7I", "ses_01m6ery9yx5src7d"]) {
      expect(SessionId.safeParse(bad).success).toBe(false)
    }
  })

  test("one factory never repeats an id within the same millisecond and keeps them sorted", () => {
    const next = createIdFactory({ now: () => 1_000, random: (size) => new Uint8Array(size) })
    const ids = Array.from({ length: 5_000 }, () => next("item"))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.toSorted()).toEqual(ids)
  })

  test("a new id sorts after an older-format id from an earlier millisecond", () => {
    const older = "itm_01M606KX5HFRJ1VBXKBT9D5FZR"
    const next = createIdFactory({ now: () => 1_793_644_776_134 })
    expect([next("item"), older].toSorted()[0]).toBe(older)
  })
})
