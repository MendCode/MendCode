import { Effect, Schema } from "effect"
import { Database } from "@/storage/db"
import * as Mailbox from "@/session/runtime-mailbox"
import type { Tool } from "./tool"
import type { Config } from "@/config/config"

const Parameters = Schema.Struct({
  action: Schema.Literals(["read", "write"]),
  version: Schema.optional(Schema.Int),
  text: Schema.optional(Schema.String),
})

export function sessionNotes(directory: string, config: Pick<Config.Interface, "get">): Tool.Def<typeof Parameters> {
  return {
    id: "session_notes",
    description: "Read or replace this session's working notes across compaction. Read first; write requires the current version to prevent lost updates. At most 16,000 characters. Read a specific version to recover earlier notes. Never writes global memory.",
    parameters: Parameters,
    execute: (args, context) => Effect.gen(function* () {
      if ((yield* config.get()).experimental?.session_recall !== true) throw new Error("Session recall is disabled")
      const headID = `notes_${context.sessionID}`
      const value = Database.transaction(() => {
        const head = Mailbox.getRecord(context.sessionID, headID)
        const currentVersion = Number(head?.data.version ?? 0)
        if (args.action === "read") {
          if (args.version !== undefined && (!Number.isSafeInteger(args.version) || args.version < 0)) throw new Error("Invalid note version")
          const record = args.version === undefined ? head : Mailbox.getRecord(context.sessionID, `${headID}_${args.version}`)
          if (args.version && !record) throw new Error("Unknown note version in this session")
          return { version: Number(record?.data.version ?? 0), text: String(record?.data.text ?? ""), current_version: currentVersion }
        }
        if (args.version !== currentVersion) throw new Error(`Notes changed or version missing; read current notes before writing (current version ${currentVersion})`)
        if (typeof args.text !== "string" || args.text.length > 16000) throw new Error("Notes require text of at most 16,000 characters")
        const version = currentVersion + 1
        const record: Mailbox.Record = { id: headID, sessionID: context.sessionID, directory,
          kind: "note", generation: Mailbox.generation(context.sessionID), status: "saved",
          data: { version, text: args.text }, timeCreated: Date.now(), timeUpdated: Date.now() }
        Mailbox.putRecord({ ...record, id: `${headID}_${version}` })
        Mailbox.putRecord(record)
        return { version, text: args.text, current_version: version }
      })
      return { title: "Session notes", output: JSON.stringify(value), metadata: { truncated: false } }
    }),
  }
}
