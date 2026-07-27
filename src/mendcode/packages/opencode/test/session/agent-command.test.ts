import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "../../src/storage/db"
import { AgentCommand } from "../../src/session/agent-command"
import { AgentCommandPolicy } from "../../src/session/agent-command-policy"
import { BackgroundSession } from "../../src/session/background"
import { AgentCommandID } from "../../src/session/schema"
import { Session as SessionNs } from "../../src/session/session"
import { AgentCommandTable, AgentViewMetadataTable, BackgroundSessionTable } from "../../src/session/session.sql"
import { WithInstance } from "../../src/project/with-instance"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service | AgentCommand.Service | BackgroundSession.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(SessionNs.defaultLayer, BackgroundSession.defaultLayer, AgentCommand.defaultLayer))))
}

const svc = {
  createSession(input?: SessionNs.CreateInput) {
    return run(Effect.gen(function* () {
      const session = yield* SessionNs.Service
      return yield* session.create(input)
    }))
  },
  create(input: AgentCommand.CreateInput) {
    return run(Effect.gen(function* () {
      const command = yield* AgentCommand.Service
      return yield* command.create(input)
    }))
  },
  get(id: AgentCommandID) {
    return run(Effect.gen(function* () {
      const command = yield* AgentCommand.Service
      return yield* command.get(id)
    }))
  },
  list(input?: AgentCommand.ListInput) {
    return run(Effect.gen(function* () {
      const command = yield* AgentCommand.Service
      return yield* command.list(input)
    }))
  },
  update(input: AgentCommand.UpdateInput) {
    return run(Effect.gen(function* () {
      const command = yield* AgentCommand.Service
      return yield* command.update(input)
    }))
  },
  registerBackground(input: BackgroundSession.RegisterInput) {
    return run(Effect.gen(function* () {
      const background = yield* BackgroundSession.Service
      return yield* background.register(input)
    }))
  },
  acquireWriter(input: BackgroundSession.WriterInput) {
    return run(Effect.gen(function* () {
      const background = yield* BackgroundSession.Service
      return yield* background.acquireWriter(input)
    }))
  },
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Agent Command inbox", () => {
  test("creates and lists structured commands by source, target, and state", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })

        const command = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: " summarize current blockers " },
        })

        expect(command).toMatchObject({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          state: "pending",
          permissions: ["session.summary.read"],
          policy: {
            decision: "safe_auto",
            permissions: ["session.summary.read"],
          },
          payload: { instructions: "summarize current blockers" },
        })
        expect((await svc.list({ targetSessionID: target.id })).map((item) => item.id)).toEqual([command.id])
        expect((await svc.list({ sourceSessionID: source.id })).map((item) => item.id)).toEqual([command.id])
        expect(await svc.list({ state: "completed" })).toEqual([])
      },
    })
  })

  test("advances valid command states and rejects terminal rewrites", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const command = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "check status" },
        })

        const accepted = await svc.update({ id: command.id, targetSessionID: target.id, state: "accepted" })
        expect(accepted.state).toBe("accepted")
        const completed = await svc.update({ id: command.id, targetSessionID: target.id, state: "completed", result: "done" })
        expect(completed).toMatchObject({ state: "completed", result: "done" })

        await expect(svc.update({ id: command.id, targetSessionID: target.id, state: "running" })).rejects.toThrow(
          "Invalid agent command state transition",
        )
      },
    })
  })

  test("applies accepted rename and tag commands to Agent View metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const rename = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "rename",
          payload: { title: "Worker Alpha" },
        })
        const tag = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "tag",
          payload: { tags: ["frontend", "urgent"] },
        })

        expect(await svc.update({ id: rename.id, targetSessionID: target.id, state: "accepted" })).toMatchObject({
          state: "completed",
          result: "Renamed target Agent View row.",
        })
        expect(await svc.update({ id: tag.id, targetSessionID: target.id, state: "accepted" })).toMatchObject({
          state: "completed",
          result: "Updated target Agent View tags.",
        })
        expect(Database.use((db) => db.select().from(AgentViewMetadataTable).where(eq(AgentViewMetadataTable.session_id, target.id)).get()?.data)).toEqual({
          title: "Worker Alpha",
          tags: ["frontend", "urgent"],
        })
      },
    })
  })

  test("stores safe rename and tag commands without changing transcript metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "Original transcript title" })

        const rename = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "rename",
          payload: { title: "  Visible worker label  " },
        })
        const tag = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "tag",
          payload: { tags: ["api", "api", "  frontend  ", ""] },
        })

        expect(rename).toMatchObject({ type: "rename", payload: { title: "Visible worker label" } })
        expect(tag).toMatchObject({ type: "tag", payload: { tags: ["api", "frontend"] } })
        expect(rename.permissions).toEqual(["agent_view.metadata.patch"])
        expect(rename.policy).toMatchObject({ decision: "same_workspace", permissions: ["agent_view.metadata.patch"] })

        const storedSession = await run(Effect.gen(function* () {
          const session = yield* SessionNs.Service
          return yield* session.get(target.id)
        }))
        expect(storedSession.title).toBe("Original transcript title")
      },
    })
  })

  test("supports execution-changing command types as explicit approval commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })

        const pause = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "pause_after_turn",
          payload: { reason: "checkpoint before next step" },
        })
        const stop = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "stop",
          payload: { reason: "cancel obsolete run" },
        })
        const message = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "send_message",
          payload: { text: "Continue with the smallest safe next step." },
        })

        expect(pause).toMatchObject({ type: "pause_after_turn", policy: { decision: "approval_required" } })
        expect(stop).toMatchObject({ type: "stop", policy: { decision: "approval_required" } })
        expect(message).toMatchObject({
          type: "send_message",
          payload: { text: "Continue with the smallest safe next step." },
          permissions: ["session.message.send"],
          policy: { decision: "approval_required" },
        })
      },
    })
  })

  test("dedupes repeated pending commands and rejects target inbox overflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const first = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "status one" },
        })
        const duplicate = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "status one" },
        })
        await svc.create({ sourceSessionID: source.id, targetSessionID: target.id, type: "request_summary", payload: { instructions: "status two" } })
        await svc.create({ sourceSessionID: source.id, targetSessionID: target.id, type: "request_summary", payload: { instructions: "status three" } })
        const overflow = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "status four" },
        })

        expect(duplicate.id).toBe(first.id)
        expect(overflow).toMatchObject({
          state: "rejected",
          error: "Target already has 3 pending commands; wait for the worker to accept or reject one first.",
        })
      },
    })
  })

  test("dedupes legacy pending commands that predate expiresAt storage", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const id = AgentCommandID.ascending()
        const now = Date.now()
        Database.use((db) =>
          db.insert(AgentCommandTable)
            .values({
              id,
              source_session_id: source.id,
              target_session_id: target.id,
              state: "pending",
              time_created: now,
              time_updated: now,
              data: {
                type: "request_summary",
                payload: { instructions: "status one" },
                permissions: ["session.summary.read"],
              },
            })
            .run(),
        )

        const duplicate = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "status one" },
        })

        expect(duplicate.id).toBe(id)
        expect(await svc.list({ targetSessionID: target.id })).toHaveLength(1)
      },
    })
  })

  test("expires pending commands before list or update returns them", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const command = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "short ttl" },
        })
        Database.use((db) => {
          const row = db.select().from(AgentCommandTable).where(eq(AgentCommandTable.id, command.id)).get()
          if (!row) throw new Error("Agent command row missing")
          db.update(AgentCommandTable)
            .set({ data: { ...row.data, expiresAt: Date.now() - 1 } })
            .where(eq(AgentCommandTable.id, command.id))
            .run()
        })

        expect(await svc.list({ targetSessionID: target.id })).toEqual([
          expect.objectContaining({ id: command.id, state: "expired", error: "Command expired before the target accepted it." }),
        ])
        await expect(svc.update({ id: command.id, targetSessionID: target.id, state: "accepted" })).rejects.toThrow(
          "Invalid agent command state transition",
        )
      },
    })
  })

  test("requires approval when only one side has workspace context", () => {
    expect(
      AgentCommandPolicy.evaluate({
        type: "rename",
        source: { directory: "/repo", workspaceID: undefined },
        target: { directory: "/repo", workspaceID: "ws-alpha" as SessionNs.Info["workspaceID"] },
      }),
    ).toMatchObject({
      decision: "approval_required",
      permissions: ["agent_view.metadata.patch"],
    })
  })

  test("allows metadata commands while another terminal is attached", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        await svc.registerBackground({ sessionID: target.id, state: "working" })
        await svc.acquireWriter({ sessionID: target.id, clientID: "terminal-a", ttlMs: 60_000 })

        const rename = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "rename",
          payload: { title: "Worker with owner" },
        })
        const summary = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "request_summary",
          payload: { instructions: "status" },
        })

        expect(rename.policy).toMatchObject({
          decision: "same_workspace",
          permissions: ["agent_view.metadata.patch"],
          reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
        })
        expect(summary.policy).toMatchObject({
          decision: "safe_auto",
          permissions: ["session.summary.read"],
        })
      },
    })
  })

  test("refreshes stored legacy writer ownership policy", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        await svc.registerBackground({ sessionID: target.id, state: "working" })
        const rename = await svc.create({
          sourceSessionID: source.id,
          targetSessionID: target.id,
          type: "rename",
          payload: { title: "Worker with stale lease" },
        })
        Database.use((db) => {
          const row = db.select().from(AgentCommandTable).where(eq(AgentCommandTable.id, rename.id)).get()
          if (!row) throw new Error("Agent command row missing")
          db.update(AgentCommandTable)
            .set({
              data: {
                ...row.data,
                policy: {
                  ...rename.policy,
                  decision: "approval_required",
                  ownership: { targetWriter: { clientID: "terminal-a", expires: Date.now() - 1 } },
                },
              },
            })
            .where(eq(AgentCommandTable.id, rename.id))
            .run()
        })

        expect(await svc.list({ targetSessionID: target.id })).toEqual([
          expect.objectContaining({
            id: rename.id,
            policy: {
              decision: "same_workspace",
              permissions: ["agent_view.metadata.patch"],
              reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
            },
          }),
        ])
      },
    })
  })

  test("reconstructs same-workspace policy for legacy rows missing policy metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        await svc.registerBackground({ sessionID: target.id, state: "working" })
        await svc.acquireWriter({ sessionID: target.id, clientID: "terminal-a", ttlMs: 60_000 })
        const id = AgentCommandID.ascending()
        const now = Date.now()
        Database.use((db) =>
          db.insert(AgentCommandTable)
            .values({
              id,
              source_session_id: source.id,
              target_session_id: target.id,
              state: "pending",
              time_created: now,
              time_updated: now,
              data: {
                type: "rename",
                payload: { title: "Legacy worker" },
                permissions: ["agent_view.metadata.patch"],
              },
            })
            .run(),
        )
        Database.use((db) => db.delete(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, target.id)).run())

        expect(await svc.list({ targetSessionID: target.id })).toEqual([
          expect.objectContaining({
            id,
            type: "rename",
            policy: {
              decision: "same_workspace",
              permissions: ["agent_view.metadata.patch"],
              reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
              ownership: undefined,
            },
          }),
        ])
      },
    })
  })

  test("reconstructs active writer ownership for legacy rows missing policy metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        await svc.registerBackground({ sessionID: target.id, state: "working" })
        await svc.acquireWriter({ sessionID: target.id, clientID: "terminal-a", ttlMs: 60_000 })
        const id = AgentCommandID.ascending()
        const now = Date.now()
        Database.use((db) =>
          db.insert(AgentCommandTable)
            .values({
              id,
              source_session_id: source.id,
              target_session_id: target.id,
              state: "pending",
              time_created: now,
              time_updated: now,
              data: {
                type: "rename",
                payload: { title: "Legacy worker" },
                permissions: ["agent_view.metadata.patch"],
              },
            })
            .run(),
        )

        expect(await svc.list({ targetSessionID: target.id })).toEqual([
          expect.objectContaining({
            id,
            type: "rename",
            policy: {
              decision: "same_workspace",
              permissions: ["agent_view.metadata.patch"],
              reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
            },
          }),
        ])
      },
    })
  })

  test("refreshes persisted policy when stored writer ownership has expired", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "coordinator" })
        const target = await svc.createSession({ title: "worker" })
        const id = AgentCommandID.ascending()
        const now = Date.now()
        Database.use((db) =>
          db.insert(AgentCommandTable)
            .values({
              id,
              source_session_id: source.id,
              target_session_id: target.id,
              state: "pending",
              time_created: now,
              time_updated: now,
              data: {
                type: "rename",
                payload: { title: "Legacy worker" },
                permissions: ["agent_view.metadata.patch"],
                policy: {
                  decision: "approval_required",
                  permissions: ["agent_view.metadata.patch"],
                  reason: "Legacy writer ownership required explicit target approval.",
                  ownership: { targetWriter: { clientID: "terminal-a", expires: now - 1_000 } },
                },
              },
            })
            .run(),
        )

        const updated = await svc.update({ id, targetSessionID: target.id, result: "checked" })
        expect(updated).toMatchObject({
          id,
          result: "checked",
          policy: {
            decision: "same_workspace",
            permissions: ["agent_view.metadata.patch"],
            reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
          },
        })
        expect(updated.policy.ownership).toBeUndefined()
        expect(await svc.list({ targetSessionID: target.id })).toEqual([
          expect.objectContaining({
            id,
            policy: {
              decision: "same_workspace",
              permissions: ["agent_view.metadata.patch"],
              reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
            },
          }),
        ])
      },
    })
  })

  test("exposes a conservative command policy matrix", () => {
    expect(AgentCommandPolicy.matrix()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_summary", decision: "safe_auto", permissions: ["session.summary.read"] }),
      expect.objectContaining({ type: "rename", decision: "same_workspace", permissions: ["agent_view.metadata.patch"] }),
      expect.objectContaining({ type: "tag", decision: "same_workspace", permissions: ["agent_view.metadata.patch"] }),
      expect.objectContaining({ type: "pause_after_turn", decision: "approval_required", permissions: ["session.control.pause_after_turn"] }),
      expect.objectContaining({ type: "stop", decision: "approval_required", permissions: ["session.control.stop"] }),
      expect.objectContaining({ type: "send_message", decision: "approval_required", permissions: ["session.message.send"] }),
    ]))
  })

  test("scopes commands to the current project and rejects cross-project targets", async () => {
    await using tmp = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })
    const local = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await svc.createSession({ title: "local source" })
        const target = await svc.createSession({ title: "local target" })
        return {
          source,
          target,
          command: await svc.create({
            sourceSessionID: source.id,
            targetSessionID: target.id,
            type: "rename",
            payload: { title: "Local label" },
          }),
        }
      },
    })
    const remote = await WithInstance.provide({
      directory: other.path,
      fn: async () => {
        const source = await svc.createSession({ title: "remote source" })
        const target = await svc.createSession({ title: "remote target" })
        return {
          source,
          target,
          command: await svc.create({
            sourceSessionID: source.id,
            targetSessionID: target.id,
            type: "tag",
            payload: { tags: ["remote"] },
          }),
        }
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await svc.list()).map((item) => item.id)).toEqual([local.command.id])
        await expect(svc.get(remote.command.id)).rejects.toMatchObject({
          name: "NotFoundError",
          data: { message: `Agent command not found: ${remote.command.id}` },
        })
        await expect(
          svc.update({ id: remote.command.id, targetSessionID: remote.target.id, state: "accepted" }),
        ).rejects.toMatchObject({
          name: "NotFoundError",
          data: { message: `Agent command not found: ${remote.command.id}` },
        })
        await expect(
          svc.create({
            sourceSessionID: local.source.id,
            targetSessionID: remote.target.id,
            type: "rename",
            payload: { title: "Cross-project" },
          }),
        ).rejects.toMatchObject({ name: "NotFoundError", data: { message: `Session not found: ${remote.target.id}` } })
      },
    })

    await WithInstance.provide({
      directory: other.path,
      fn: async () => {
        expect((await svc.list()).map((item) => item.id)).toEqual([remote.command.id])
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await svc.list({ targetSessionID: remote.target.id })).toEqual([])
        expect(await svc.list({ sourceSessionID: remote.source.id })).toEqual([])
      },
    })
  })
})
