import type { TuiPluginApi, TuiSlotContext, TuiSlotMap, TuiSlotProps } from "@mendcode/plugin/tui"
import { createSlot, createSolidSlotRegistry, type JSX, type SolidPlugin } from "@opentui/solid"
import { ErrorBoundary } from "solid-js"
import { isRecord } from "@/util/record"

type RuntimeSlotMap = TuiSlotMap<Record<string, object>>

type Slot = <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
export type HostSlotPlugin<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type HostPluginApi = TuiPluginApi
export type HostSlots = {
  register: {
    (plugin: HostSlotPlugin): () => void
    <Slots extends Record<string, object>>(plugin: HostSlotPlugin<Slots>): () => void
  }
}

function empty<Name extends string>(props: TuiSlotProps<Name>) {
  return props.children ?? null
}

let view: Slot = empty

const protectedFallbackSlots = new Set(["home_prompt", "session_prompt"])

function slotFallback<Name extends string>(props: TuiSlotProps<Name>, error?: unknown) {
  if (error) {
    console.error("[tui.slot] render error", {
      slot: props.name,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return props.children ?? null
}

function normalizeSlotValue<Name extends string>(value: unknown, props: TuiSlotProps<Name>) {
  if (value === null || value === undefined || typeof value === "boolean") return props.children ?? null
  if (typeof value === "string" || typeof value === "number") {
    return props.children ?? <text wrapMode="word">{String(value)}</text>
  }
  return value as JSX.Element
}

export const Slot: Slot = (props) => (
  <ErrorBoundary fallback={(error) => slotFallback(props, error)}>
    {normalizeSlotValue(view(props), props)}
  </ErrorBoundary>
)

function sanitizeSlotPlugin(plugin: HostSlotPlugin<Record<string, object>>): HostSlotPlugin<Record<string, object>> {
  const slots: Record<string, (ctx: TuiSlotContext, props: object) => JSX.Element | null> = {}
  for (const [name, render] of Object.entries(plugin.slots)) {
    if (!render) continue
    if (protectedFallbackSlots.has(name)) continue
    slots[name] = (ctx, props) => {
      const slotProps = { name, ...(isRecord(props) ? props : {}) } as TuiSlotProps<string>
      try {
        return normalizeSlotValue(render(ctx as never, slotProps as never), slotProps)
      } catch (error) {
        return slotFallback(slotProps, error)
      }
    }
  }
  return { ...plugin, slots }
}

function isHostSlotPlugin(value: unknown): value is HostSlotPlugin<Record<string, object>> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  if (!isRecord(value.slots)) return false
  return true
}

export function setupSlots(api: HostPluginApi): HostSlots {
  const reg = createSolidSlotRegistry<RuntimeSlotMap, TuiSlotContext>(
    api.renderer,
    {
      theme: api.theme,
    },
    {
      onPluginError(event) {
        console.error("[tui.slot] plugin error", {
          plugin: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          source: event.source,
          message: event.error.message,
        })
      },
    },
  )

  const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props)
  return {
    register(plugin: HostSlotPlugin) {
      if (!isHostSlotPlugin(plugin)) return () => {}
      return reg.register(sanitizeSlotPlugin(plugin))
    },
  }
}
