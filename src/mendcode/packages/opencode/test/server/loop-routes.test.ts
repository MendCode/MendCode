import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { defaultLayer as loopWorkflowLayer, LoopWorkflow, Service as LoopWorkflowService } from "../../src/session/loop"
import { Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { Flag } from "@mendcode/core/flag/flag"

const originalServerPassword = Flag.OPENCODE_SERVER_PASSWORD
const originalServerUsername = Flag.OPENCODE_SERVER_USERNAME
const originalEnvServerPassword = process.env.OPENCODE_SERVER_PASSWORD
const originalEnvServerUsername = process.env.OPENCODE_SERVER_USERNAME

function runLoop<A, E>(fx: Effect.Effect<A, E, LoopWorkflowService>) {
  return Effect.runPromise(fx.pipe(Effect.provide(loopWorkflowLayer)))
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = originalServerPassword
  Flag.OPENCODE_SERVER_USERNAME = originalServerUsername
  if (originalEnvServerPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = originalEnvServerPassword
  if (originalEnvServerUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = originalEnvServerUsername
  await disposeAllInstances()
})

describe("loop routes", () => {
  test("draft, activate, run once, events, and stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Legacy().app

        const draftResponse = await app.request("/loop/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "PR babysitter",
            objective: "Watch PR comments and report actionable work.",
            trigger: { mode: "interval", intervalMs: 60_000 },
          }),
        })
        expect(draftResponse.status).toBe(200)
        const draft = (await draftResponse.json()) as LoopWorkflow.Info
        expect(draft.state).toBe("draft")

        const listResponse = await app.request("/loop")
        expect(listResponse.status).toBe(200)
        const list = (await listResponse.json()) as LoopWorkflow.Info[]
        expect(list.map((loop) => loop.id)).toContain(draft.id)

        const globalListResponse = await app.request("/loop/global")
        expect(globalListResponse.status).toBe(200)
        const globalList = (await globalListResponse.json()) as LoopWorkflow.GlobalInfo[]
        expect(globalList.find((loop) => loop.id === draft.id)?.project).toMatchObject({ id: draft.projectID })
        expect(globalList.find((loop) => loop.id === draft.id)?.project.worktree).toBeTruthy()

        const activateResponse = await app.request(`/loop/${draft.id}/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test activate", ensureService: false }),
        })
        expect(activateResponse.status).toBe(200)
        const active = (await activateResponse.json()) as LoopWorkflow.Info
        expect(active.rootSessionID).toBeDefined()
        expect(active.state).toBe("sleeping")

        const runResponse = await app.request(`/loop/${draft.id}/run-once`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test run" }),
        })
        expect(runResponse.status).toBe(200)
        expect((await runResponse.json()) as LoopWorkflow.RunInfo).toMatchObject({ trigger: "run-once", state: "completed" })

        const eventsResponse = await app.request(`/loop/${draft.id}/events`)
        expect(eventsResponse.status).toBe(200)
        const events = (await eventsResponse.json()) as LoopWorkflow.JournalEvent[]
        expect(events.map((event) => event.type)).toEqual(["created", "activated", "wake"])

        const stopResponse = await app.request(`/loop/${draft.id}/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "done" }),
        })
        expect(stopResponse.status).toBe(200)
        expect((await stopResponse.json()) as LoopWorkflow.Info).toMatchObject({ state: "stopped" })

        const deleteResponse = await app.request(`/loop/${draft.id}`, { method: "DELETE" })
        expect(deleteResponse.status).toBe(200)
        expect((await deleteResponse.json()) as LoopWorkflow.Info).toMatchObject({ id: draft.id, state: "stopped" })
      },
    })
  })

  test("effect httpapi raw loop route lists and controls workflows", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const legacy = Server.Legacy().app
        const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const effect = {
          request(input: string | URL | Request, init?: RequestInit) {
            return handler(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init), ExperimentalHttpApiServer.context)
          },
        }
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

        const draftResponse = await legacy.request("/loop/draft", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Effect dashboard loop",
            objective: "Verify Effect raw route can serve the loops dashboard.",
            trigger: { mode: "interval", intervalMs: 60_000 },
          }),
        })
        expect(draftResponse.status).toBe(200)
        const draft = (await draftResponse.json()) as LoopWorkflow.Info

        const listResponse = await effect.request("/loop", { headers })
        expect(listResponse.status).toBe(200)
        const list = (await listResponse.json()) as LoopWorkflow.Info[]
        expect(list.map((loop) => loop.id)).toContain(draft.id)

        const globalListResponse = await effect.request("/loop/global", { headers })
        expect(globalListResponse.status).toBe(200)
        const globalList = (await globalListResponse.json()) as LoopWorkflow.GlobalInfo[]
        expect(globalList.find((loop) => loop.id === draft.id)?.project).toMatchObject({ id: draft.projectID })
        expect(globalList.find((loop) => loop.id === draft.id)?.project.worktree).toBeTruthy()

        const snapshotResponse = await effect.request(`/loop/${draft.id}`, { headers })
        expect(snapshotResponse.status).toBe(200)
        expect((await snapshotResponse.json()) as LoopWorkflow.Snapshot).toMatchObject({
          workflow: { id: draft.id, name: "Effect dashboard loop" },
        })

        const limitedSnapshotResponse = await effect.request(`/loop/${draft.id}?limit=1`, { headers })
        expect(limitedSnapshotResponse.status).toBe(200)
        const limitedSnapshot = (await limitedSnapshotResponse.json()) as LoopWorkflow.Snapshot
        expect(limitedSnapshot.events).toHaveLength(1)

        const limitedEventsResponse = await effect.request(`/loop/${draft.id}/events?limit=1`, { headers })
        expect(limitedEventsResponse.status).toBe(200)
        expect((await limitedEventsResponse.json()) as LoopWorkflow.JournalEvent[]).toHaveLength(1)

        const stopResponse = await effect.request(`/loop/${draft.id}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "dashboard stop" }),
        })
        expect(stopResponse.status).toBe(200)
        expect((await stopResponse.json()) as LoopWorkflow.Info).toMatchObject({ state: "stopped" })

        const deleteResponse = await effect.request(`/loop/${draft.id}`, { method: "DELETE", headers })
        expect(deleteResponse.status).toBe(200)
        expect((await deleteResponse.json()) as LoopWorkflow.Info).toMatchObject({ id: draft.id, state: "stopped" })
      },
    })
  })

  test("legacy and effect routes serve matching bounded global loop history pages", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const legacy = Server.Legacy().app
        const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const effect = (path: string) => handler(
          new Request(new URL(path, "http://localhost"), { headers: { "x-opencode-directory": tmp.path } }),
          ExperimentalHttpApiServer.context,
        )
        const historyResponse = await legacy.request("/loop/global/page?limit=1")
        const historyTotal = ((await historyResponse.json()) as LoopWorkflow.GlobalPage).page.total
        const first = await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({ name: "First history", objective: "First global history item." })))
        await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({ name: "Second history", objective: "Second global history item." })))
        await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({ name: "Third history", objective: "Third global history item." })))
        const active = await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({ name: "Active", objective: "Remain outside history pages." })))
        await runLoop(LoopWorkflowService.use((loop) => loop.activate({ id: active.id })))

        const path = `/loop/global/page?offset=0&limit=1&selectedID=${first.id}`
        const legacyResponse = await legacy.request(path)
        const effectResponse = await effect(path)
        expect(legacyResponse.status).toBe(200)
        expect(effectResponse.status).toBe(200)
        const legacyPage = (await legacyResponse.json()) as LoopWorkflow.GlobalPage
        const effectPage = (await effectResponse.json()) as LoopWorkflow.GlobalPage
        expect(legacyPage).toEqual(effectPage)
        expect(legacyPage.active.map((item) => item.id)).toContain(active.id)
        expect(legacyPage.history.map((item) => item.id)).toEqual([first.id])
        expect(legacyPage.page).toEqual({ offset: 2, limit: 1, total: historyTotal + 3 })

        const legacyGlobal = await legacy.request("/loop/global")
        expect((await legacyGlobal.json() as LoopWorkflow.GlobalInfo[]).map((item) => item.id)).toEqual(expect.arrayContaining([first.id, active.id]))
      },
    })
  })

  test("legacy and effect routes expose loop supervision summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const legacy = Server.Legacy().app
        const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const effect = {
          request(input: string | URL | Request, init?: RequestInit) {
            return handler(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init), ExperimentalHttpApiServer.context)
          },
        }
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const draft = await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({
          name: "Summary route loop",
          objective: "Expose operator summary metadata.",
          budgetMode: "max-goal",
          memory: { enabled: true, sections: ["tried", "verified", "open", "decisions", "rejected"] },
        })))
        await runLoop(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "summary route activate" })))
        const run = await runLoop(LoopWorkflowService.use((loop) => loop.startRun({ id: draft.id, trigger: "manual", reason: "summary route run" })))
        await runLoop(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: run.id,
          reason: "Summary route checkpoint.",
          checkpoint: {
            status: "continue",
            summary: "Continue after checking evidence.",
            evidence: ["focused route evidence"],
            nextAction: "Render loop detail view.",
          },
          gateResults: [{ id: "checkpoint-proposal", status: "pass", summary: "Checkpoint parsed.", failureClass: "none" }],
          usage: { cost: 0.03, tokens: { input: 5, output: 7 } },
        })))

        const legacySummaryResponse = await legacy.request(`/loop/${draft.id}/summary`, { headers })
        expect(legacySummaryResponse.status).toBe(200)
        const legacySummary = (await legacySummaryResponse.json()) as LoopWorkflow.Summary
        expect(legacySummary).toMatchObject({ workflowID: draft.id, verdict: "continue", nextAction: "Render loop detail view." })
        expect(legacySummary.evidenceSummary).toContain("focused route evidence")
        expect(legacySummary.gateSummary.pass).toBe(1)
        expect(legacySummary.memorySummary.total).toBeGreaterThan(0)
        expect(legacySummary.costSummary.tokens).toBe(12)

        const legacyListResponse = await legacy.request("/loop/summary", { headers })
        expect(legacyListResponse.status).toBe(200)
        const legacyList = (await legacyListResponse.json()) as LoopWorkflow.Summary[]
        expect(legacyList.find((item) => item.workflowID === draft.id)?.verdictSummary).toBe("Continue after checking evidence.")

        const effectSummaryResponse = await effect.request(`/loop/${draft.id}/summary`, { headers })
        expect(effectSummaryResponse.status).toBe(200)
        expect((await effectSummaryResponse.json()) as LoopWorkflow.Summary).toMatchObject({ workflowID: draft.id, verdict: "continue" })

        const effectListResponse = await effect.request("/loop/summary", { headers })
        expect(effectListResponse.status).toBe(200)
        expect(((await effectListResponse.json()) as LoopWorkflow.Summary[]).map((item) => item.workflowID)).toContain(draft.id)
      },
    })
  })

  test("signal and override routes require auth and stay behaviorally aligned", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        delete process.env.OPENCODE_SERVER_PASSWORD
        Flag.OPENCODE_SERVER_PASSWORD = undefined
        const openLegacy = Server.Legacy().app
        const openEffectHandler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const openEffect = (path: string, init?: RequestInit) => openEffectHandler(new Request(new URL(path, "http://localhost"), init), ExperimentalHttpApiServer.context)
        const signalBody = JSON.stringify({ source: "ci", type: "ci.check.failed", dedupeKey: "unauthenticated" })
        expect((await openLegacy.request("/loop/signal", { method: "POST", headers: { "content-type": "application/json" }, body: signalBody })).status).toBe(401)
        expect((await openEffect("/loop/signal", { method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": tmp.path }, body: signalBody })).status).toBe(401)

        process.env.OPENCODE_SERVER_PASSWORD = "loop-secret"
        process.env.OPENCODE_SERVER_USERNAME = "operator"
        Flag.OPENCODE_SERVER_PASSWORD = "loop-secret"
        Flag.OPENCODE_SERVER_USERNAME = "operator"
        const authorization = `Basic ${btoa("operator:loop-secret")}`
        const headers = { authorization, "content-type": "application/json", "x-opencode-directory": tmp.path }
        const draft = await runLoop(LoopWorkflowService.use((loop) => loop.createDraft({
          name: "Authenticated signal loop",
          objective: "Receive trusted CI events.",
          trigger: { mode: "external-signal" },
        })))
        await runLoop(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id })))

        const legacy = Server.Legacy().app
        const effectHandler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const effect = (path: string, init?: RequestInit) => effectHandler(new Request(new URL(path, "http://localhost"), init), ExperimentalHttpApiServer.context)
        const wrongHeaders = {
          authorization: `Basic ${btoa("operator:wrong-secret")}`,
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        }
        expect((await legacy.request("/loop/signal", { method: "POST", headers: wrongHeaders, body: signalBody })).status).toBe(401)
        expect((await effect("/loop/signal", { method: "POST", headers: wrongHeaders, body: signalBody })).status).toBe(401)
        const missingWorkflowBody = JSON.stringify({ source: "ci", type: "ci.check.failed", dedupeKey: "missing-workflow" })
        expect((await legacy.request("/loop/signal", { method: "POST", headers, body: missingWorkflowBody })).status).toBe(400)
        expect((await effect("/loop/signal", { method: "POST", headers, body: missingWorkflowBody })).status).toBe(400)
        const spoofedReceivedAt = Date.now() + 60_000
        const legacySignal = await legacy.request("/loop/signal", {
          method: "POST",
          headers,
          body: JSON.stringify({ workflowID: draft.id, source: "ci", type: "ci.check.failed", dedupeKey: "legacy-event", receivedAt: spoofedReceivedAt }),
        })
        expect(legacySignal.status).toBe(200)
        const legacySignalBody = await legacySignal.json() as { deduped: boolean; rateLimited: boolean; signal: { receivedAt: number } }
        expect(legacySignalBody).toMatchObject({ deduped: false, rateLimited: false })
        expect(legacySignalBody.signal.receivedAt).toBeLessThan(spoofedReceivedAt)
        const effectSignal = await effect("/loop/signal", {
          method: "POST",
          headers,
          body: JSON.stringify({ workflowID: draft.id, source: "ci", type: "ci.check.failed", dedupeKey: "effect-event" }),
        })
        expect(effectSignal.status).toBe(200)
        expect(await effectSignal.json()).toMatchObject({ deduped: false, rateLimited: false })

        const run = await runLoop(LoopWorkflowService.use((loop) => loop.startRun({ id: draft.id, trigger: "manual" })))
        await runLoop(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: run.id,
          checkpoint: { status: "blocked", summary: "Quality gate needs operator review." },
          gateResults: [{ id: "review-quality", status: "blocked", failureClass: "quality", summary: "Manual review requested." }],
        })))
        const waived = await legacy.request(`/loop/${draft.id}/override`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "waive", gateID: "review-quality", reason: "Reviewed and accepted by operator." }),
        })
        expect(waived.status).toBe(200)
        expect(await waived.json()).toMatchObject({ state: "active" })
        const accepted = await effect(`/loop/${draft.id}/override`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "accept", reason: "Accept after audited waiver." }),
        })
        expect(accepted.status).toBe(200)
        expect(await accepted.json()).toMatchObject({ state: "completed" })
      },
    })
  })
})
