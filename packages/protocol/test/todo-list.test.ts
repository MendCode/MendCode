import { expect, test } from "bun:test"
import { todoListCard, type TodoListItem } from "../src"

const item = (status: TodoListItem["status"], text: string = status): TodoListItem => ({ text, status })

test("the card title counts finished items over the ones not cancelled, like the progress row", () => {
  const list = [item("done", "a"), item("done", "b"), item("in_progress", "c"), item("pending", "d"), item("pending", "e"), item("pending", "f"), item("cancelled", "g")]
  const card = todoListCard(list)
  expect(card.title).toBe("todo 2/6")
  // The card still lists the cancelled item, marked.
  expect(card.text.split("\n")).toHaveLength(7)
  expect(card.text).toContain("[-] g")
})

test("a list of only cancelled items reads todo 0/0, an empty one too, and a cancelled item never counts as done", () => {
  expect(todoListCard([item("cancelled"), item("cancelled")]).title).toBe("todo 0/0")
  expect(todoListCard([]).title).toBe("todo 0/0")
  expect(todoListCard([item("done"), item("cancelled")]).title).toBe("todo 1/1")
})
