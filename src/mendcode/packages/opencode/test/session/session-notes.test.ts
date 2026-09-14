import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { sessionNotes } from "@/tool/session-notes"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)
it.instance("session notes retain revisions, reject stale writes and isolate sessions", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const a = yield* sessions.create({ title: "Notes A" })
  const b = yield* sessions.create({ title: "Notes B" })
  const tool = sessionNotes("fixture", { get: () => Effect.succeed({ experimental: { session_recall: true } }) })
  const ctx: Tool.Context = { sessionID: a.id, messageID: MessageID.ascending(), agent: "build",
    abort: new AbortController().signal, messages: [], ask: () => Effect.void, metadata: () => Effect.void }
  const read = (args: Parameters<typeof tool.execute>[0], context = ctx) => tool.execute(args, context).pipe(Effect.map((result) => JSON.parse(result.output)))
  expect(yield* read({ action: "read" })).toMatchObject({ version: 0, text: "" })
  yield* read({ action: "write", version: 0, text: "First objective" })
  yield* read({ action: "write", version: 1, text: "Updated objective" })
  expect(yield* read({ action: "read", version: 1 })).toMatchObject({ version: 1, text: "First objective", current_version: 2 })
  expect(yield* read({ action: "read" }, { ...ctx, sessionID: b.id })).toMatchObject({ version: 0, text: "" })
  expect(yield* read({ action: "write", version: 1, text: "Lost update" }).pipe(Effect.exit)).toHaveProperty("_tag", "Failure")
  expect(yield* read({ action: "write", version: 2, text: "x".repeat(16001) }).pipe(Effect.exit)).toHaveProperty("_tag", "Failure")
  expect(yield* read({ action: "read" })).toMatchObject({ version: 2, text: "Updated objective" })
  const disabled = sessionNotes("fixture", { get: () => Effect.succeed({}) })
  expect(yield* disabled.execute({ action: "write", version: 2, text: "disabled" }, ctx).pipe(Effect.exit)).toHaveProperty("_tag", "Failure")
}))
