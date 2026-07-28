import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { mendPaths } from "@/mend/config/paths"
import {
  parsePromptModel,
  readModelsConfig,
  resolveEffectivePromptSelection,
  resolveLocalPromptModel,
  type PromptModelRef,
  type PromptModelSource,
} from "@/mend/config/models"

export type RuntimeModelResolution = {
  agent: string
  model?: { providerID: string; modelID: string }
  variant?: string
  source: PromptModelSource
  sessionUsesSubagent: boolean
  models: {
    enabled: boolean
    path: string
  }
}

export function resolveRuntimeModel(input: {
  session?: Session.Info
  explicitAgent?: string
  explicitModel?: string
  explicitVariant?: string
}) {
  return Effect.gen(function* () {
    const directory = yield* InstanceState.directory
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const models = yield* Effect.promise(() => readModelsConfig(directory))
    const configInfo = yield* config.get()
    const agentList = yield* agents.list()
    const agent = input.explicitAgent ?? input.session?.agent ?? (yield* agents.defaultAgent())
    const agentInfo = agentList.find((item) => item.name === agent)
    const primaryAgentNames = agentList
      .filter((item) => item.mode !== "subagent" && !item.hidden)
      .map((item) => item.name)
    const sessionUsesSubagent = Boolean(input.session?.agent && !primaryAgentNames.includes(input.session.agent))
    const userInfo =
      input.session &&
      (yield* sessions.messages({ sessionID: input.session.id })).findLast((item) => item.info.role === "user")?.info
    const userModel = userInfo?.role === "user" ? userInfo.model : undefined
    const fallbackModel = yield* provider.defaultModel().pipe(Effect.orElseSucceed(() => undefined))
    const configured = resolveLocalPromptModel({
      configModel: configInfo.model,
      configuredRoleModel: models.enabled ? models.roles[agent] : undefined,
      agentModel: agentInfo?.model,
      defaultRoleModel: models.enabled ? models.roles.default : undefined,
      fallbackModel,
    })
    const selected = resolveEffectivePromptSelection({
      hasSession: Boolean(input.session),
      explicitModel: parsePromptModel(input.explicitModel),
      explicitVariant: input.explicitVariant,
      localModel: configured.model,
      localModelSource: configured.source,
      userModel,
      sessionModel: input.session?.model,
      agentModel: sessionUsesSubagent ? agentInfo?.model : undefined,
      sessionUsesSubagent,
    })
    return {
      agent,
      model: selected.model,
      variant: selected.variant ?? undefined,
      source: selected.source,
      sessionUsesSubagent,
      models: {
        enabled: models.enabled,
        path: mendPaths(directory).modelsConfig,
      },
    } satisfies RuntimeModelResolution
  })
}

export function modelRef(model: PromptModelRef | undefined) {
  if (!model?.providerID) return undefined
  const modelID = model.modelID ?? model.id
  if (!modelID) return undefined
  return { providerID: model.providerID, modelID }
}

export * as ModelSelection from "./model-selection"
