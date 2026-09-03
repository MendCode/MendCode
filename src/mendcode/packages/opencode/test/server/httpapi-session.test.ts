import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Flag } from "@mendcode/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { PermissionID } from "../../src/permission/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { WithInstance } from "../../src/project/with-instance"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import type { BackgroundSession } from "@/session/background"
import type { AgentViewMetadata } from "@/session/agent-view-metadata"
import type { AgentCommand } from "@/session/agent-command"
import { AgentCommandID, MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@/storage/db"
import { AgentCommandTable, SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionMessage } from "../../src/v2/session-message"
import { Modelv2 } from "../../src/v2/model"
import * as DateTime from "effect/DateTime"
import * as Log from "@mendcode/core/util/log"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

function app(experimental = true) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(directory: string, input?: Session.CreateInput) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () => runSession(Session.Service.use((svc) => svc.create(input))),
      }),
  )
}

function createTextMessage(directory: string, sessionID: SessionIDType, text: string) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () =>
          runSession(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const info = yield* svc.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID,
                agent: "build",
                model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
                time: { created: Date.now() },
              })
              const part = yield* svc.updatePart({
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text,
              })
              return { info, part }
            }),
          ),
      }),
  )
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.gen(function* () {
    registerAdapter(input.projectID, input.type, localAdapter(input.directory))
    return yield* Workspace.Service.use((svc) =>
      svc.create({
        type: input.type,
        branch: null,
        extra: null,
        projectID: input.projectID,
      }),
    ).pipe(Effect.provide(Workspace.defaultLayer))
  })

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => app().request(path, init))
}

function requestWithBackend(experimental: boolean, path: string, init?: RequestInit) {
  return Effect.promise(async () => app(experimental).request(path, init))
}

function json<T>(response: Response) {
  return Effect.promise(async () => {
    if (response.status !== 200) throw new Error(await response.text())
    return (await response.json()) as T
  })
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

function withTmp<A, E, R>(
  options: Parameters<typeof tmpdir>[0],
  fn: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(fn))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.live(
    "returns declared not found errors for read routes",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const session = yield* createSession(tmp.path, { title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    ),
  )

  it.live(
    "serves read routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const parent = yield* createSession(tmp.path, { title: "parent" })
        const child = yield* createSession(tmp.path, { title: "child", parentID: parent.id })
        const message = yield* createTextMessage(tmp.path, parent.id, "hello")
        yield* createTextMessage(tmp.path, parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          yield* requestJson<AgentViewMetadata.Info>(pathFor(SessionPaths.agentViewMetadata, { sessionID: parent.id }), {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ title: "Coordinator label", tags: ["ops", "ops", "api"], priority: "normal" }),
          }),
        ).toMatchObject({ title: "Coordinator label", tags: ["ops", "api"], priority: "normal" })

        expect(
          yield* requestJson<AgentViewMetadata.Info | null>(
            pathFor(SessionPaths.agentViewMetadata, { sessionID: parent.id }),
            { headers },
          ),
        ).toMatchObject({ title: "Coordinator label", tags: ["ops", "api"] })

        expect(
          (yield* requestJson<AgentViewMetadata.Info[]>(SessionPaths.agentViewMetadataList, { headers })).map(
            (item) => item.sessionID,
          ),
        ).toContain(parent.id)

        const command = yield* requestJson<AgentCommand.Info>(pathFor(SessionPaths.agentCommand, { sessionID: parent.id }), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ sourceSessionID: child.id, type: "tag", payload: { tags: ["ops", "ops", "api"] } }),
        })
        expect(command).toMatchObject({
          sourceSessionID: child.id,
          targetSessionID: parent.id,
          type: "tag",
          state: "pending",
          payload: { tags: ["ops", "api"] },
          policy: { decision: "same_workspace", permissions: ["agent_view.metadata.patch"] },
        })

        expect(yield* requestJson<unknown[]>(SessionPaths.agentCommandPolicy, { headers })).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "request_summary", decision: "safe_auto" }),
          expect.objectContaining({ type: "rename", decision: "same_workspace" }),
          expect.objectContaining({ type: "tag", decision: "same_workspace" }),
          expect.objectContaining({ type: "pause_after_turn", decision: "approval_required" }),
          expect.objectContaining({ type: "stop", decision: "approval_required" }),
          expect.objectContaining({ type: "send_message", decision: "approval_required" }),
        ]))

        yield* requestJson<BackgroundSession.Info>(pathFor(SessionPaths.backgroundRegister, { sessionID: parent.id }), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ state: "working" }),
        })
        yield* requestJson<unknown>(pathFor(SessionPaths.backgroundWriter, { sessionID: parent.id }), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ clientID: "terminal-a", ttlMs: 60_000 }),
        })
        expect(
          yield* requestJson<AgentCommand.Info>(pathFor(SessionPaths.agentCommand, { sessionID: parent.id }), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ sourceSessionID: child.id, type: "rename", payload: { title: "Owner guarded" } }),
          }),
        ).toMatchObject({
          policy: {
            decision: "same_workspace",
          },
        })

        expect(
          (yield* requestJson<AgentCommand.Info[]>(pathFor(SessionPaths.agentCommand, { sessionID: parent.id }), { headers })).map(
            (item) => item.id,
          ),
        ).toContain(command.id)

         expect(
           yield* requestJson<AgentCommand.Info>(
             pathFor(SessionPaths.agentCommandItem, { sessionID: parent.id, commandID: command.id }),
             {
               method: "PATCH",
               headers: { ...headers, "content-type": "application/json" },
               body: JSON.stringify({ state: "accepted" }),
             },
           ),
         ).toMatchObject({ id: command.id, state: "completed", result: "Updated target Agent View tags." })

         expect(
           yield* requestJson<AgentCommand.Info>(
             pathFor(SessionPaths.agentCommandItem, { sessionID: parent.id, commandID: command.id }),
             {
               method: "PATCH",
               headers: { ...headers, "content-type": "application/json" },
               body: JSON.stringify({ state: "completed", result: "done" }),
             },
           ),
         ).toMatchObject({ id: command.id, state: "completed", result: "done" })

         for (const experimental of [false, true]) {
           const invalidTransition = yield* requestWithBackend(
             experimental,
             pathFor(SessionPaths.agentCommandItem, { sessionID: parent.id, commandID: command.id }),
             {
               method: "PATCH",
               headers: { ...headers, "content-type": "application/json" },
               body: JSON.stringify({ state: "running" }),
             },
           )
           expect(invalidTransition.status).toBe(400)
         }

         expect(
           (yield* requestJson<AgentCommand.Info[]>(`${SessionPaths.agentCommandList}?sourceSessionID=${child.id}&state=completed`, {
             headers,
           })).map((item) => item.id),
         ).toEqual([command.id])


        expect(
          (yield* requestJson<unknown[]>(`${SessionPaths.agentView}?roots=true`, { headers })).map((item) =>
            (item as { sessionID?: string }).sessionID,
          ),
        ).toContain(parent.id)

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<MessageV2.WithParts[]>(messages)
        const nextCursor = messages.headers.get("x-next-cursor")
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<MessageV2.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* Effect.promise(() =>
          WithInstance.provide({
            directory: tmp.path,
            fn: async () => {
              const message = new SessionMessage.Assistant({
                id: SessionMessage.ID.create(),
                type: "assistant",
                agent: "build",
                model: {
                  id: Modelv2.ID.make("model"),
                  providerID: Modelv2.ProviderID.make("provider"),
                  variant: Modelv2.VariantID.make("default"),
                },
                time: { created: DateTime.makeUnsafe(1) },
                content: [new SessionMessage.AssistantText({ type: "text", text: "x".repeat(9_000) })],
              })
              Database.use((db) =>
                db
                  .insert(SessionMessageTable)
                  .values([
                    {
                      id: message.id,
                      session_id: parent.id,
                      type: message.type,
                      time_created: 1,
                      data: {
                        time: { created: 1 },
                        agent: message.agent,
                        model: message.model,
                        content: message.content,
                      } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
                    },
                  ])
                  .run(),
              )
            },
          }),
        )

        expect(
          (yield* requestJson<{ items: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, { headers }))
            .items,
        ).toMatchObject([{ type: "assistant" }])

        const tuiMessages = (
          yield* requestJson<{ items: SessionMessage.Message[] }>(`/api/session/${parent.id}/message?view=tui`, {
            headers,
          })
        ).items
        const assistant = tuiMessages.find((message) => message.type === "assistant")
        const content = assistant?.type === "assistant" ? assistant.content[0] : undefined
        expect(content).toMatchObject({
          type: "text",
          text: "x".repeat(9_000),
        })
        expect(content?.type === "text" ? content.text : "").not.toContain("TUI preview truncated")
      }),
    ),
  )

  it.live(
    "matches legacy invalid agent-command transition responses",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const source = yield* createSession(tmp.path, { title: "source" })
        const target = yield* createSession(tmp.path, { title: "target" })
        const createBody = JSON.stringify({ sourceSessionID: source.id, type: "request_summary", payload: { instructions: "status" } })

        const exercise = (experimental: boolean) =>
          Effect.gen(function* () {
            const created = yield* requestWithBackend(
              experimental,
              pathFor(SessionPaths.agentCommand, { sessionID: target.id }),
              { method: "POST", headers, body: createBody },
            ).pipe(Effect.flatMap(json<AgentCommand.Info>))

            yield* requestWithBackend(
              experimental,
              pathFor(SessionPaths.agentCommandItem, { sessionID: target.id, commandID: created.id }),
              { method: "PATCH", headers, body: JSON.stringify({ state: "accepted" }) },
            ).pipe(Effect.flatMap(json<AgentCommand.Info>))

            return yield* requestWithBackend(
              experimental,
              pathFor(SessionPaths.agentCommandItem, { sessionID: target.id, commandID: created.id }),
              { method: "PATCH", headers, body: JSON.stringify({ state: "pending" }) },
            ).pipe(
              Effect.flatMap((response) =>
                Effect.promise(async () => ({
                  status: response.status,
                  body: await response.json(),
                })),
              ),
            )
          })

        const legacy = yield* exercise(false)
        const effect = yield* exercise(true)

        expect(legacy.status).toBe(400)
        expect(effect.status).toBe(400)
        expect(legacy.body).toMatchObject({
          success: false,
          data: null,
          errors: [
            {
              name: "AgentCommandInvalidStateTransitionError",
              message: "Invalid agent command state transition: accepted -> pending",
              commandID: expect.any(String),
              from: "accepted",
              to: "pending",
            },
          ],
        })
        expect(effect.body).toMatchObject({
          success: false,
          data: null,
          errors: [
            {
              name: legacy.body.errors[0]?.name,
              message: legacy.body.errors[0]?.message,
              commandID: expect.any(String),
              from: legacy.body.errors[0]?.from,
              to: legacy.body.errors[0]?.to,
            },
          ],
        })
      }),
    ),
  )

  it.live(
    "keeps agent-command routes project-scoped across legacy and HttpApi backends",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const localSource = yield* createSession(tmp.path, { title: "local source" })
        const localTarget = yield* createSession(tmp.path, { title: "local target" })
        const localCommand = yield* requestJson<AgentCommand.Info>(pathFor(SessionPaths.agentCommand, { sessionID: localTarget.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ sourceSessionID: localSource.id, type: "rename", payload: { title: "Local label" } }),
        })

        const other = yield* Effect.promise(() => tmpdir({ git: true, config: { formatter: false, lsp: false } }))
        const otherHeaders = { "x-opencode-directory": other.path, "content-type": "application/json" }
        try {
          const remoteSource = yield* createSession(other.path, { title: "remote source" })
          const remoteTarget = yield* createSession(other.path, { title: "remote target" })
          const remoteCommand = yield* requestJson<AgentCommand.Info>(pathFor(SessionPaths.agentCommand, { sessionID: remoteTarget.id }), {
            method: "POST",
            headers: otherHeaders,
            body: JSON.stringify({ sourceSessionID: remoteSource.id, type: "tag", payload: { tags: ["remote"] } }),
          })

          expect(
            (yield* requestJson<AgentCommand.Info[]>(SessionPaths.agentCommandList, { headers })).map((item) => item.id),
          ).toEqual([localCommand.id])
          expect(
            (yield* requestJson<AgentCommand.Info[]>(SessionPaths.agentCommandList, { headers: otherHeaders })).map((item) => item.id),
          ).toEqual([remoteCommand.id])

          for (const experimental of [false, true]) {
            const crossProjectFilteredList = yield* requestWithBackend(
              experimental,
              `${SessionPaths.agentCommandList}?targetSessionID=${remoteTarget.id}`,
              { headers },
            )
            expect(crossProjectFilteredList.status).toBe(200)
            expect(yield* responseJson(crossProjectFilteredList)).toEqual([])

            const crossProjectPatch = yield* requestWithBackend(
              experimental,
              pathFor(SessionPaths.agentCommandItem, { sessionID: remoteTarget.id, commandID: remoteCommand.id }),
              {
                method: "PATCH",
                headers,
                body: JSON.stringify({ state: "accepted" }),
              },
            )
            expect(crossProjectPatch.status).toBe(404)
            expect(yield* responseJson(crossProjectPatch)).toEqual({
              name: "NotFoundError",
              data: { message: `Agent command not found: ${remoteCommand.id}` },
            })

            const crossProjectCreate = yield* requestWithBackend(
              experimental,
              pathFor(SessionPaths.agentCommand, { sessionID: remoteTarget.id }),
              {
                method: "POST",
                headers,
                body: JSON.stringify({ sourceSessionID: localSource.id, type: "rename", payload: { title: "Cross-project" } }),
              },
            )
            expect(crossProjectCreate.status).toBe(404)
            expect(yield* responseJson(crossProjectCreate)).toEqual({
              name: "NotFoundError",
              data: { message: `Session not found: ${remoteTarget.id}` },
            })
          }
        } finally {
          yield* Effect.promise(() => other[Symbol.asyncDispose]())
        }
      }),
    ),
  )

  it.live(
    "refreshes stale stored agent-command writer ownership across legacy and HttpApi backends",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const source = yield* createSession(tmp.path, { title: "source" })
        const target = yield* createSession(tmp.path, { title: "target" })
        const commandID = AgentCommandID.ascending()
        const now = Date.now()

        yield* Effect.promise(() =>
          WithInstance.provide({
            directory: tmp.path,
            fn: async () => {
              Database.use((db) =>
                db.insert(AgentCommandTable)
                  .values({
                    id: commandID,
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
            },
          }),
        )

        for (const experimental of [false, true]) {
          const updated = yield* requestWithBackend(
            experimental,
            pathFor(SessionPaths.agentCommandItem, { sessionID: target.id, commandID }),
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({ result: "checked" }),
            },
          ).pipe(Effect.flatMap(json<AgentCommand.Info>))

          expect(updated).toMatchObject({
            id: commandID,
            result: "checked",
            policy: {
              decision: "same_workspace",
              permissions: ["agent_view.metadata.patch"],
              reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
            },
          })
          expect(updated.policy.ownership).toBeUndefined()
        }
      }),
    ),
  )

  it.live(
    "serves lifecycle mutation routes through Hono bridge",

    withTmp({ git: true, config: { formatter: false, lsp: false, share: "disabled" } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.id).not.toBe(created.id)

        expect(
          yield* requestJson<string>(pathFor(SessionPaths.cancelTurn, { sessionID: created.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ targetMessageID: MessageID.ascending() }),
          }),
        ).toBe("not_running")

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)
        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.interrupt, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(false)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    ),
  )

  it.live(
    "persists selected workspace id when creating a session",
    withTmp({ git: true, config: { formatter: false, lsp: false, share: "disabled" } }, (tmp) =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(tmp.path).pipe(Effect.provide(Project.defaultLayer))
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(tmp.path, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select({ workspaceID: SessionTable.workspace_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, created.id))
                .get(),
            ),
          ),
        ).toEqual({ workspaceID: workspace.id })
      }),
    ),
  )

  it.live(
    "matches legacy agent-view aggregate directory filtering",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const other = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true, config: { formatter: false, lsp: false } })),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )

        const scoped = yield* createSession(tmp.path, { title: "scoped background" })
        const sibling = yield* createSession(other.path, { title: "sibling background" })

        const register = (experimental: boolean, sessionID: string, summary: string, directory: string) =>
          Effect.promise(
            async () => {
              const response = await WithInstance.provide({
                directory,
                fn: () =>
                  app(experimental).request(pathFor(SessionPaths.backgroundRegister, { sessionID }), {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ state: "working", summary }),
                  }),
              })
              return await response
            },
          )

        expect((yield* register(false, scoped.id, "here", tmp.path)).status).toBe(200)
        expect((yield* register(false, sibling.id, "elsewhere", other.path)).status).toBe(200)

        const route = `${SessionPaths.agentView}?roots=true&directory=${encodeURIComponent(tmp.path)}`
        const legacy = yield* requestWithBackend(false, route, { headers: { "x-opencode-directory": tmp.path } })
        const effect = yield* requestWithBackend(true, route, { headers: { "x-opencode-directory": tmp.path } })
        const legacyItems = yield* json<BackgroundSession.Entry[]>(legacy)
        const effectItems = yield* json<BackgroundSession.Entry[]>(effect)

        expect(legacyItems.map((item) => item.sessionID)).toContain(scoped.id)
        expect(legacyItems.map((item) => item.sessionID)).not.toContain(sibling.id)
        expect(effectItems.map((item) => item.sessionID)).toEqual(legacyItems.map((item) => item.sessionID))
      }),
    ),
  )

  it.live(
    "matches legacy archived timestamp validation",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const legacy = yield* createSession(tmp.path, { title: "legacy" })
        const effect = yield* createSession(tmp.path, { title: "effect" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const legacyResponse = yield* requestWithBackend(
          false,
          pathFor(SessionPaths.update, { sessionID: legacy.id }),
          {
            method: "PATCH",
            headers,
            body,
          },
        )
        expect(legacyResponse.status).toBe(200)
        expect((yield* json<Session.Info>(legacyResponse)).time.archived).toBe(-1)

        const effectResponse = yield* requestWithBackend(true, pathFor(SessionPaths.update, { sessionID: effect.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(effectResponse.status).toBe(legacyResponse.status)
        expect((yield* json<Session.Info>(effectResponse)).time.archived).toBe(-1)
      }),
    ),
  )

  it.live(
    "matches legacy project-scoped path and directory precedence",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const currentDir = path.join(tmp.path, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const pathSession = yield* createSession(currentDir)
        const pathlessSession = yield* createSession(currentDir)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, pathlessSession.id)).run(),
          ),
        )

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": tmp.path }
        const legacy = (yield* json<Session.Info[]>(
          yield* requestWithBackend(false, `${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)
        const effect = (yield* json<Session.Info[]>(
          yield* requestWithBackend(true, `${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(legacy).toContain(pathSession.id)
        expect(legacy).not.toContain(pathlessSession.id)
        expect(effect).toEqual(legacy)
      }),
    ),
  )

  it.live(
    "matches legacy paginated message link headers",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const session = yield* createSession(tmp.path, { title: "messages" })
        yield* createTextMessage(tmp.path, session.id, "first")
        const compact = yield* createTextMessage(tmp.path, session.id, "second")
        yield* Effect.promise(() =>
          WithInstance.provide({
            directory: tmp.path,
            fn: () =>
              runSession(
                Effect.gen(function* () {
                  const svc = yield* Session.Service
                  yield* svc.updatePart({
                    id: PartID.ascending(),
                    sessionID: session.id,
                    messageID: compact.info.id,
                    type: "compaction",
                    auto: true,
                  })
                  yield* svc.updateMessage({
                    id: MessageID.ascending(),
                    sessionID: session.id,
                    parentID: compact.info.id,
                    role: "assistant",
                    mode: "compaction",
                    agent: "compaction",
                    path: { cwd: tmp.path, root: tmp.path },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    providerID: ProviderID.make("test"),
                    modelID: ModelID.make("test"),
                    summary: true,
                    time: { created: Date.now(), completed: Date.now() },
                  })
                }),
              ),
          }),
        )
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1&view=tui`

        const legacy = yield* requestWithBackend(false, route, { headers })
        const effect = yield* requestWithBackend(true, route, { headers })

        expect(legacy.status).toBe(200)
        expect(effect.status).toBe(200)
        expect(legacy.headers.get("x-message-view-sparse")).toBe("true")
        expect(effect.headers.get("x-message-view-sparse")).toBe("true")
        expect(effect.headers.get("x-next-cursor")).toBe(legacy.headers.get("x-next-cursor"))
        expect(effect.headers.get("link")).toBe(legacy.headers.get("link"))
        expect(effect.headers.get("access-control-expose-headers")).toBe(
          legacy.headers.get("access-control-expose-headers"),
        )
      }),
    ),
  )

  it.live(
    "serves message mutation routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const session = yield* createSession(tmp.path, { title: "messages" })
        const first = yield* createTextMessage(tmp.path, session.id, "first")
        const second = yield* createTextMessage(tmp.path, session.id, "second")

        const updated = yield* requestJson<MessageV2.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live(
    "serves remaining non-LLM session mutation routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const session = yield* createSession(tmp.path, { title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.permissions, {
              sessionID: session.id,
              permissionID: String(PermissionID.ascending()),
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ response: "once" }),
            },
          ),
        ).toBe(true)
      }),
    ),
  )
})
