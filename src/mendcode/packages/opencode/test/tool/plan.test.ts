import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { PlanReview } from "@/plan-review"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { PlanReviewTool } from "@/tool/plan-review"
import { switchToBuildAgent } from "@/tool/plan"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("test")
const planModelID = ModelID.make("plan-model")
const buildModelID = ModelID.make("build-model")

function model(modelID: ModelID, variants: Provider.Model["variants"] = {}) {
  return {
    id: modelID,
    providerID,
    api: { id: modelID, npm: "@ai-sdk/openai-compatible", url: "https://example.com/v1" },
    name: modelID,
    capabilities: {
      attachment: false,
      reasoning: false,
      temperature: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_000 },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants,
  } satisfies Provider.Model
}

function providerLayer(defaultModelID = planModelID) {
  return Layer.mock(Provider.Service)({
    list: () =>
      Effect.succeed({
        [providerID]: {
          id: providerID,
          name: "Test",
          source: "config" as const,
          env: [],
          options: {},
          models: {
            [planModelID]: model(planModelID, { xhigh: {} }),
            [buildModelID]: model(buildModelID, { high: {} }),
          },
        },
      }),
    getProvider: () =>
      Effect.succeed({
        id: providerID,
        name: "Test",
        source: "config" as const,
        env: [],
        options: {},
        models: {},
      }),
    getModel: (_providerID, modelID) =>
      Effect.succeed(model(modelID, modelID === buildModelID ? { high: {} } : { xhigh: {} })),
    getLanguage: () => Effect.die("not implemented"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed({ providerID, modelID: defaultModelID }),
  })
}

const baseLayer = Layer.mergeAll(
  Agent.defaultLayer,
  Config.defaultLayer,
  providerLayer(),
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(baseLayer)
const itBuildDefault = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer, providerLayer(buildModelID), CrossSpawnSpawner.defaultLayer, Session.defaultLayer),
)
const itPlanReview = testEffect(
  Layer.mergeAll(
    baseLayer,
    Layer.mock(PlanReview.Service)({
      ask: () =>
        Effect.succeed({
          action: "apply" as const,
          markdown: "# Approved\n\n- ship it",
          comments: "Looks good",
        }),
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    }),
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_plan-test"),
  messageID: MessageID.make("msg_plan-test"),
  callID: "",
  agent: "plan",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

function syntheticHandoff(messages: MessageV2.WithParts[]) {
  return messages.find(
    (message) => message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic),
  )
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance(
  "switchToBuildAgent uses configured destination agent model and variant",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const agents = yield* Agent.Service
      const session = yield* sessions.create({ title: "Plan handoff" })

      const planUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "plan",
        model: { providerID, modelID: planModelID, variant: "xhigh" },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: planUser.id,
        sessionID: session.id,
        type: "text",
        text: "draft a plan",
      } satisfies MessageV2.TextPart)

      yield* switchToBuildAgent({
        session: sessions,
        provider,
        agents,
        sessionID: session.id,
        agent: "build",
        text: "Implement this approved plan.",
      })

      const handoff = syntheticHandoff(yield* sessions.messages({ sessionID: session.id }))
      expect(handoff?.info.role).toBe("user")
      if (handoff?.info.role !== "user") return
      expect(handoff.info.agent).toBe("build")
      expect(handoff.info.model).toEqual({ providerID, modelID: buildModelID, variant: "high" })

      const updated = yield* sessions.get(session.id)
      expect(updated.agent).toBe("build")
      expect(updated.model).toEqual({ providerID, id: buildModelID, variant: "high" })
    }),
  {
    git: true,
    config: {
      agent: {
        build: {
          model: "test/build-model",
          variant: "high",
        },
        plan: {
          model: "test/plan-model",
          variant: "xhigh",
        },
      },
    },
  },
)

it.instance(
  "switchToBuildAgent does not leak the prior variant onto a different configured destination model",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const agents = yield* Agent.Service
      const session = yield* sessions.create({ title: "Plan handoff" })

      const planUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "plan",
        model: { providerID, modelID: planModelID, variant: "xhigh" },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: planUser.id,
        sessionID: session.id,
        type: "text",
        text: "draft a plan",
      } satisfies MessageV2.TextPart)

      yield* switchToBuildAgent({
        session: sessions,
        provider,
        agents,
        sessionID: session.id,
        agent: "build",
        text: "Implement this approved plan.",
      })

      const handoff = syntheticHandoff(yield* sessions.messages({ sessionID: session.id }))
      expect(handoff?.info.role).toBe("user")
      if (handoff?.info.role !== "user") return
      expect(handoff.info.model).toEqual({ providerID, modelID: buildModelID, variant: undefined })

      const updated = yield* sessions.get(session.id)
      expect(updated.model).toEqual({ providerID, id: buildModelID, variant: undefined })
    }),
  {
    git: true,
    config: {
      agent: {
        build: {
          model: "test/build-model",
        },
        plan: {
          model: "test/plan-model",
          variant: "xhigh",
        },
      },
    },
  },
)

itBuildDefault.instance(
  "switchToBuildAgent ignores a configured destination variant when no destination model is configured",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const agents = yield* Agent.Service
      const session = yield* sessions.create({ title: "Plan handoff" })

      yield* switchToBuildAgent({
        session: sessions,
        provider,
        agents,
        sessionID: session.id,
        agent: "build",
        text: "Implement this approved plan.",
      })

      const handoff = syntheticHandoff(yield* sessions.messages({ sessionID: session.id }))
      expect(handoff?.info.role).toBe("user")
      if (handoff?.info.role !== "user") return
      expect(handoff.info.model).toEqual({ providerID, modelID: buildModelID, variant: undefined })

      const updated = yield* sessions.get(session.id)
      expect(updated.model).toEqual({ providerID, id: buildModelID, variant: undefined })
    }),
  {
    git: true,
    config: {
      agent: {
        build: {
          variant: "high",
        },
      },
    },
  },
)

itPlanReview.instance(
  "plan_review apply updates the displayed plan, switches session metadata, and emits the implementation handoff",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* PlanReviewTool
      const tool = yield* toolInfo.init()
      const session = yield* sessions.create({ title: "Plan handoff" })
      const prompt = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "plan",
        model: { providerID, modelID: planModelID, variant: "xhigh" },
        time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: session.id,
        parentID: prompt.id,
        mode: "plan",
        agent: "plan",
        cost: 0,
        path: { cwd: ".", root: "." },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: planModelID,
        providerID,
        time: { created: Date.now() },
        finish: "tool-calls",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "tool",
        tool: "plan_review",
        callID: "call-plan-review",
        state: {
          status: "running",
          input: { title: "Draft", markdown: "# Draft\n\n- first pass" },
          time: { start: Date.now() },
        },
      } satisfies MessageV2.ToolPart)

      const result = yield* tool.execute(
        { title: "Draft", markdown: "# Draft\n\n- first pass" },
        { ...ctx, sessionID: session.id, messageID: assistant.id, callID: "call-plan-review" },
      )

      const reviewedPart = MessageV2.parts(assistant.id).find(
        (part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === "call-plan-review",
      )
      expect(reviewedPart?.state.input).toEqual({ title: "Draft", markdown: "# Approved\n\n- ship it" })
      expect(result.metadata).toMatchObject({ planExitAgent: "build" })

      const handoff = syntheticHandoff(yield* sessions.messages({ sessionID: session.id }))
      expect(handoff?.info.role).toBe("user")
      if (handoff?.info.role !== "user") return
      expect(handoff.info.agent).toBe("build")
      expect(handoff.info.model).toEqual({ providerID, modelID: planModelID, variant: "xhigh" })
      expect(handoff.parts.some((part) => part.type === "text" && part.text.includes("# Approved\n\n- ship it"))).toBe(true)
      expect(handoff.parts.some((part) => part.type === "text" && part.text.includes("User implementation comments:\nLooks good"))).toBe(true)

      const updated = yield* sessions.get(session.id)
      expect(updated.agent).toBe("build")
      expect(updated.model).toEqual({ providerID, id: planModelID, variant: "xhigh" })
    }),
  { git: true },
)
