import { expect, test } from "bun:test"
import { AttachmentPasteResult, Command, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const ref = { sha256: "a".repeat(64), mime: "application/pdf", bytes: 2048 }

test("the PDF result is additive; every legacy paste result still parses", () => {
  for (const value of [{ kind: "document", attachment: ref, name: "design.pdf" }, { kind: "image", attachment: { ...ref, mime: "image/png" }, name: "shot.png" }, { kind: "mention", path: "src" }, { kind: "text", name: "notes.txt", content: "notes" }]) expect(AttachmentPasteResult.safeParse(value).success).toBe(true)
  expect(AttachmentPasteResult.safeParse({ kind: "document", attachment: { ...ref, sha256: "wrong" }, name: "design.pdf" }).success).toBe(false)
})

test("attachment paths are bounded and attachment commands remain unavailable to read-only peers", () => {
  const base = { id: ids("command"), clientId: ids("client"), type: "attachment.paste", path: "/tmp/design.pdf" }
  expect(Command.safeParse(base).success).toBe(true)
  expect(Command.safeParse({ ...base, path: "x".repeat(4097) }).success).toBe(false)
  for (const command of ["attachment.paste", "attachment.add", "attachment.clipboard"] as const) expect(isReadOnlyCommand(command)).toBe(false)
})
