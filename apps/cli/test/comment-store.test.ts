import { describe, expect, test } from "bun:test"
import { createCommentStore } from "../src/ui/comment-store"
import { MAX_COMMENTS } from "../src/view/reply-comments"

describe("the comment store", () => {
  test("add keeps order and ids, refuses empty words, an empty quote and the tenth", () => {
    const store = createCommentStore()
    expect(store.add({ quote: "q", text: "   " })).toBeUndefined()
    expect(store.add({ quote: "  ", text: "t" })).toBeUndefined()
    for (let n = 1; n <= MAX_COMMENTS; n++) expect(store.add({ quote: `q${n}`, text: `t${n}`, itemId: "item_1" })?.id).toBe(n)
    expect(store.add({ quote: "q10", text: "t10" })).toBeUndefined()
    expect(store.list.map((comment) => comment.text)).toEqual(Array.from({ length: MAX_COMMENTS }, (_, index) => `t${index + 1}`))
  })

  test("the caller's own limit counts, and never exceeds the global one", () => {
    const store = createCommentStore()
    expect(store.add({ quote: "a", text: "a" }, 1)).toBeDefined()
    expect(store.add({ quote: "b", text: "b" }, 1)).toBeUndefined()
    expect(store.add({ quote: "b", text: "b" }, 99)).toBeDefined()
  })

  test("edit, remove and move work on ids, so a reorder does not confuse them", () => {
    const store = createCommentStore()
    const [a, b, c] = ["a", "b", "c"].map((word) => store.add({ quote: word, text: word })!)
    expect(store.move(a!.id, 1)).toBe(1)
    expect(store.list.map((comment) => comment.text)).toEqual(["b", "a", "c"])
    expect(store.move(a!.id, 1)).toBe(2)
    expect(store.move(a!.id, 1)).toBeUndefined()
    expect(store.move(b!.id, -1)).toBeUndefined()
    expect(store.edit(c!.id, " changed ")).toBe(true)
    expect(store.edit(c!.id, "   ")).toBe(false)
    expect(store.edit(999, "x")).toBe(false)
    expect(store.remove(b!.id)).toBe(true)
    expect(store.remove(b!.id)).toBe(false)
    expect(store.list.map((comment) => comment.text)).toEqual(["changed", "a"])
  })

  test("parking sets them aside and drops out of what is sent; adding or unparking brings them back", () => {
    const store = createCommentStore()
    expect(store.park()).toBe(false)
    store.add({ quote: "q", text: "t" })
    expect(store.active()).toHaveLength(1)
    expect(store.park()).toBe(true)
    expect(store.park()).toBe(false)
    expect(store.active()).toEqual([])
    expect(store.count).toBe(1)
    store.add({ quote: "q2", text: "t2" })
    expect(store.parked).toBe(false)
    expect(store.active()).toHaveLength(2)
    store.park()
    expect(store.unpark()).toBe(true)
    expect(store.unpark()).toBe(false)
    store.clear()
    expect(store.count).toBe(0)
    expect(store.parked).toBe(false)
  })

  test("removing the last comment ends the parked state", () => {
    const store = createCommentStore()
    const only = store.add({ quote: "q", text: "t" })!
    store.park()
    store.remove(only.id)
    expect(store.parked).toBe(false)
  })

  test("orphan drops the anchor of comments whose message is gone and keeps the quote", () => {
    const store = createCommentStore()
    store.add({ quote: "old", text: "t", itemId: "item_old" })
    store.add({ quote: "new", text: "t", itemId: "item_new" })
    store.add({ quote: "code", text: "t", other: true })
    const before = store.revision
    expect(store.orphan((itemId) => itemId === "item_new")).toBe(true)
    expect(store.list.map((comment) => comment.itemId)).toEqual([undefined, "item_new", undefined])
    expect(store.list[0]?.quote).toBe("old")
    expect(store.list[2]?.other).toBe(true)
    expect(store.revision).toBeGreaterThan(before)
    expect(store.orphan((itemId) => itemId === "item_new")).toBe(false)
  })

  test("restore renumbers, caps at the most, and parks only when there is something", () => {
    const store = createCommentStore()
    store.restore(Array.from({ length: 12 }, (_, index) => ({ id: 50 + index, quote: `q${index}`, text: `t${index}` })), true)
    expect(store.count).toBe(MAX_COMMENTS)
    expect(store.list.map((comment) => comment.id)).toEqual(Array.from({ length: MAX_COMMENTS }, (_, index) => index + 1))
    expect(store.parked).toBe(true)
    store.restore([], true)
    expect(store.parked).toBe(false)
    expect(store.add({ quote: "q", text: "t" })?.id).toBe(1)
  })

  test("reset forgets everything, including the open modes, and names the next owner", () => {
    const store = createCommentStore()
    store.add({ quote: "q", text: "t" })
    store.composing = { quote: "q", saved: { text: "", cursor: 0, shell: false } }
    store.listing = { selected: 0 }
    store.offer = { quote: "q", until: 1, copied: true }
    expect(store.modal).toBe(true)
    store.reset("session_2")
    expect(store.count).toBe(0)
    expect(store.modal).toBe(false)
    expect(store.offer).toBeUndefined()
    expect(store.owner).toBe("session_2")
  })
})
