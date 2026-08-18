import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@mendcode/core/global"
import { iife } from "@/util/iife"
import { useToast } from "../ui/toast"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { readModelsConfig, type ModelRole } from "@/mend/config/models"
import { useMendTuiProfile } from "./mend"
import { useRoute } from "./route"
import { nextPromptVariant, resolveSelectedPromptModel, resolveSelectedPromptVariant } from "../component/prompt/agent"

type ModelSource = "user" | "hydrated" | "agent"

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const mend = useMendTuiProfile()
    const route = useRoute()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      createEffect(() => {
        const selected = agentStore.current
        if (!selected) return
        if (agents().some((x) => x.name === selected)) return
        const fallback = agents().at(0)
        if (!fallback) return
        setAgentStore("current", fallback.name)
        toast.show({
          variant: "info",
          message: `Mode ${selected} is no longer available; switched to ${fallback.name}.`,
          duration: 5000,
        })
      })
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        mendDefault?: {
          providerID: string
          modelID: string
          variant?: string | null
        }
        mendRoles: Record<
          string,
          {
            providerID: string
            modelID: string
            variant?: string | null
          }
        >
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        modelSource: Record<string, ModelSource | undefined>
        modelUpdatedAt: Record<string, number | undefined>
        modelOverrideMessageID: Record<string, string | undefined>
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
        variantSource: Record<string, ModelSource | undefined>
        variantUpdatedAt: Record<string, number | undefined>
        variantOverrideMessageID: Record<string, string | undefined>
      }>({
        ready: false,
        mendDefault: undefined,
        mendRoles: {},
        model: {},
        modelSource: {},
        modelUpdatedAt: {},
        modelOverrideMessageID: {},
        recent: [],
        favorite: [],
        variant: {},
        variantSource: {},
        variantUpdatedAt: {},
        variantOverrideMessageID: {},
      })

      const filePath = path.join(Global.Path.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void Filesystem.writeJson(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
        })
      }

      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      async function refreshMendModelPolicy() {
        const config = await readModelsConfig(mend.root).catch(() => undefined)
        if (!config?.enabled) {
          setModelStore("mendDefault", undefined)
          setModelStore("mendRoles", {})
          return
        }
        const configuredRoles = {
          ...config.roles,
          build: config.roles.build ?? config.roles.code,
        }
        const roles = Object.fromEntries(
          Object.entries(configuredRoles).flatMap(([name, role]) => {
            if (!role?.providerID || !role.modelID) return []
            return [[name, { providerID: role.providerID, modelID: role.modelID, variant: role.variant }]]
          }),
        )
        setModelStore("mendDefault", roles.default)
        setModelStore("mendRoles", roles)
      }

      void refreshMendModelPolicy()
      const mendModelRefresh = setInterval(() => void refreshMendModelPolicy(), 2000)
      onCleanup(() => clearInterval(mendModelRefresh))

      createEffect(() => {
        if (!modelStore.ready) return
        if (sync.data.provider.length === 0) return
        const recent = modelStore.recent.filter((item) => isModelValid(item))
        const favorite = modelStore.favorite.filter((item) => isModelValid(item))
        const changed = recent.length !== modelStore.recent.length || favorite.length !== modelStore.favorite.length
        if (!changed) return
        batch(() => {
          setModelStore("recent", recent)
          setModelStore("favorite", favorite)
        })
        save()
      })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        const mendDefault = modelStore.mendDefault
        if (mendDefault && isModelValid(mendDefault)) return mendDefault

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const scopedModelAgentName = createMemo(() => {
        const a = agent.current()
        if (route.data.type !== "session") return a?.name
        const session = sync.session.get(route.data.sessionID)
        if (session?.agent && !agent.list().some((item) => item.name === session.agent)) return session.agent
        return a?.name ?? session?.agent
      })

      const scopedModelKey = createMemo(() => {
        const name = scopedModelAgentName()
        if (!name) return undefined
        if (route.data.type === "session") return `session:${route.data.sessionID}:${name}`
        return `agent:${name}`
      })

      function scopedAgentInfo() {
        return sync.data.agent.find((item) => item.name === scopedModelAgentName() && !item.hidden) ?? agent.current()
      }

      function configuredScopedAgentModel() {
        const a = scopedAgentInfo()
        return getFirstValidModel(
          () => a && modelStore.mendRoles[a.name],
          () => a && a.model,
        )
      }

      const currentModel = createMemo(() => {
        const a = scopedAgentInfo()
        const key = scopedModelKey()
        const scopedModel = key ? modelStore.model[key] : undefined
        const scopedSource = key ? modelStore.modelSource[key] : undefined
        return (
          getFirstValidModel(
            () => (scopedSource === "agent" ? undefined : scopedModel),
            () => a && modelStore.mendRoles[a.name],
            () => (scopedSource === "agent" ? scopedModel : undefined),
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      function routePromptModel() {
        const localModel = currentModel()
        if (route.data.type !== "session") return localModel
        const session = sync.session.get(route.data.sessionID)
        const user = (sync.data.message[route.data.sessionID] ?? []).findLast((item) => item.role === "user")
        const key = scopedModelKey()
        const source = key ? modelStore.modelSource[key] : undefined
        const override = key && (source === "user" || source === "agent") ? modelStore.model[key] : undefined
        const sessionAgent = sync.data.agent.find((item) => item.name === session?.agent && !item.hidden)
        return resolveSelectedPromptModel({
          hasSession: true,
          sessionUsesSubagent: Boolean(
            sessionAgent?.name && !agent.list().some((item) => item.name === sessionAgent.name),
          ),
          localModel,
          localOverride: override,
          localOverrideUpdatedAt: key ? modelStore.modelUpdatedAt[key] : undefined,
          localOverrideMessageID: key ? modelStore.modelOverrideMessageID[key] : undefined,
          userModel: user?.role === "user" ? user.model : undefined,
          userModelCreatedAt: user?.time.created,
          userMessageID: user?.role === "user" ? user.id : undefined,
          sessionModel: session?.model,
          agentModel: sessionAgent?.model,
        })
      }

      function latestUserMessageID() {
        if (route.data.type !== "session") return undefined
        return (sync.data.message[route.data.sessionID] ?? []).findLast((item) => item.role === "user")?.id
      }

      function variantScopeKey(model: { providerID: string; modelID: string } | undefined) {
        if (!model) return undefined
        const scope = scopedModelKey()
        return scope ? `${scope}:${model.providerID}/${model.modelID}` : `${model.providerID}/${model.modelID}`
      }

      function setModel(
        model: { providerID: string; modelID: string },
        options?: { recent?: boolean; ifUnset?: boolean; source?: ModelSource },
      ) {
        let updated = false
        batch(() => {
          if (!isModelValid(model)) {
            toast.show({
              message: `Model ${model.providerID}/${model.modelID} is not valid`,
              variant: "warning",
              duration: 3000,
            })
            return
          }
          const key = scopedModelKey()
          if (!key) return
          if (options?.ifUnset && modelStore.model[key]) return
          const source = options?.source ?? "user"
          const existing = modelStore.model[key]
          if (
            source === "hydrated" &&
            (modelStore.modelSource[key] === "user" || modelStore.modelSource[key] === "agent") &&
            existing &&
            (existing.providerID !== model.providerID || existing.modelID !== model.modelID)
          ) {
            return
          }
          setModelStore("model", key, model)
          if (source === "user" || source === "agent" || modelStore.modelSource[key] !== "user") setModelStore("modelSource", key, source)
          if (source === "user" || source === "agent") {
            setModelStore("modelUpdatedAt", key, Date.now())
            setModelStore("modelOverrideMessageID", key, latestUserMessageID())
          }
          updated = true
          if (options?.recent) {
            const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
            if (uniq.length > 10) uniq.pop()
            setModelStore(
              "recent",
              uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          }
        })
        return updated
      }

      function selectedVariant(model?: { providerID: string; modelID: string }) {
        const m = model ?? currentModel()
        if (!m) return undefined
        const a = scopedAgentInfo()
        const key = variantScopeKey(m)
        if (!key) return undefined
        const value = modelStore.variant[key]
        const stored = value === "default" ? undefined : value
        const source = modelStore.variantSource[key]
        const role = a ? modelStore.mendRoles[a.name] : undefined
        const localVariant = value !== undefined && source !== "agent"
          ? stored
          : role?.providerID === m.providerID && role.modelID === m.modelID
            ? role.variant ?? undefined
            : stored
        const session = route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined
        const user = route.data.type === "session"
          ? (sync.data.message[route.data.sessionID] ?? []).findLast((item) => item.role === "user")
          : undefined
        const userModel = user?.role === "user" && user.model.providerID === m.providerID && user.model.modelID === m.modelID
          ? user.model
          : undefined
        const sessionModelID = session?.model?.id
        const sessionModel = session?.model?.providerID === m.providerID && sessionModelID === m.modelID
          ? session.model
          : undefined
        return resolveSelectedPromptVariant({
          hasSession: route.data.type === "session",
          localVariant,
          hasLocalVariantOverride: value !== undefined && (source === "user" || source === "agent"),
          localVariantOverrideUpdatedAt: modelStore.variantUpdatedAt[key],
          localVariantOverrideMessageID: modelStore.variantOverrideMessageID[key],
          userModel,
          userModelCreatedAt: userModel ? user?.time.created : undefined,
          userMessageID: userModel ? user?.id : undefined,
          sessionModel,
        })
      }

      function setVariant(
        value: string | undefined,
        options?: {
          ifUnset?: boolean
          source?: ModelSource
          model?: { providerID: string; modelID: string }
        },
      ) {
        const m = options?.model ?? currentModel()
        if (!m) return
        const scope = scopedModelKey()
        const key = scope ? `${scope}:${m.providerID}/${m.modelID}` : `${m.providerID}/${m.modelID}`
        if (options?.ifUnset && modelStore.variant[key] !== undefined) return
        const source = options?.source ?? "user"
        if (
          source === "hydrated" &&
          (modelStore.variantSource[key] === "user" || modelStore.variantSource[key] === "agent") &&
          modelStore.variant[key] !== undefined &&
          modelStore.variant[key] !== (value ?? "default")
        ) {
          return
        }
        setModelStore("variant", key, value ?? "default")
        if (source === "user" || source === "agent" || modelStore.variantSource[key] !== "user") setModelStore("variantSource", key, source)
        if (source === "user" || source === "agent") {
          setModelStore("variantUpdatedAt", key, Date.now())
          setModelStore("variantOverrideMessageID", key, latestUserMessageID())
        }
      }

      return {
        current: currentModel,
        pinCurrent(options?: { recent?: boolean }) {
          const current = currentModel()
          if (!current) return false
          const variant = selectedVariant(current)
          const updated = setModel(current, { recent: options?.recent, source: "user" })
          if (updated) setVariant(variant, { model: current, source: "user" })
          return updated
        },
        pinAgentCurrent(options?: { recent?: boolean }) {
          const current = configuredScopedAgentModel() ?? currentModel()
          if (!current) return false
          const variant = selectedVariant(current)
          const updated = setModel(current, { recent: options?.recent, source: "agent" })
          if (updated) setVariant(variant, { model: current, source: "agent" })
          return updated
        },
        override() {
          const key = scopedModelKey()
          if (!key) return undefined
          if (modelStore.modelSource[key] !== "user") return undefined
          const model = modelStore.model[key]
          if (!model || !isModelValid(model)) return undefined
          return model
        },
        overrideInfo() {
          const key = scopedModelKey()
          if (!key) return undefined
          if (modelStore.modelSource[key] !== "user" && modelStore.modelSource[key] !== "agent") return undefined
          const model = modelStore.modelSource[key] === "agent" ? currentModel() : modelStore.model[key]
          if (!model || !isModelValid(model)) return undefined
          return {
            model,
            updatedAt: modelStore.modelUpdatedAt[key] ?? 0,
            messageID: modelStore.modelOverrideMessageID[key],
          }
        },
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const key = scopedModelKey()
          if (!key) return
            setModelStore("model", key, { ...val })
            setModelStore("modelSource", key, "user")
            setModelStore("modelUpdatedAt", key, Date.now())
            setModelStore("modelOverrideMessageID", key, latestUserMessageID())
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const key = scopedModelKey()
          if (!key) return
          setModelStore("model", key, { ...next })
          setModelStore("modelSource", key, "user")
          setModelStore("modelUpdatedAt", key, Date.now())
          setModelStore("modelOverrideMessageID", key, latestUserMessageID())
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set: setModel,
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          hasOverride(model?: { providerID: string; modelID: string }) {
            const key = variantScopeKey(model ?? currentModel())
            if (!key) return false
            return modelStore.variantSource[key] === "user" || modelStore.variantSource[key] === "agent"
          },
          overrideInfo(model?: { providerID: string; modelID: string }) {
            const key = variantScopeKey(model ?? currentModel())
            if (!key) return undefined
            if (modelStore.variantSource[key] !== "user" && modelStore.variantSource[key] !== "agent") return undefined
            const raw = modelStore.variant[key]
            return {
              variant: raw === "default" ? undefined : raw,
              updatedAt: modelStore.variantUpdatedAt[key] ?? 0,
              messageID: modelStore.variantOverrideMessageID[key],
            }
          },
          override(model?: { providerID: string; modelID: string }) {
            const key = variantScopeKey(model ?? currentModel())
            if (!key) return undefined
            if (modelStore.variantSource[key] !== "user") return undefined
            if (modelStore.variant[key]) {
              const value = modelStore.variant[key]
              return value === "default" ? undefined : value
            }
            if (modelStore.variant[key] === "default") return undefined
            return undefined
          },
          selected: selectedVariant,
          current(model?: { providerID: string; modelID: string }) {
            const v = this.selected(model)
            if (!v) return undefined
            if (!this.list(model).includes(v)) return undefined
            return v
          },
          list(model?: { providerID: string; modelID: string }) {
            const m = model ?? currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set: setVariant,
          cycle() {
            const model = routePromptModel()
            const variants = this.list(model)
            if (variants.length === 0) return
            this.set(nextPromptVariant(variants, this.current(model)), { model })
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      if (model.current() && isModelValid(model.current()!)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
    }
    return result
  },
})
