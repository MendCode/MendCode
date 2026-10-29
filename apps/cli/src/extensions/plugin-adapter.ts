import type { Extension, Line, SlotContext, SlotName, TuiActions, TuiExtensionAPI } from "@mendcode/extension-api"
import { record } from "@mendcode/extension-api/plugin-files"
import type { ExtensionFile } from "./discover"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { panelGrid } from "../view/deck"
import type { Line as TerminalLine } from "../ui/theme"

export type RowPluginContext = { version: string; directory: string; current(): SessionId; request(command: CommandInput): Promise<CommandReply> }

const SLOTS: Record<string, SlotName> = {
  home_logo: "welcome.replace", home_prompt: "prompt.replace", home_prompt_right: "prompt.above", home_bottom: "welcome.below", home_footer: "footer.replace",
  session_prompt: "prompt.replace", session_prompt_right: "prompt.above", sidebar_title: "sidebar:plugin-title", sidebar_content: "sidebar:plugin-content", sidebar_footer: "sidebar:plugin-footer",
}

/** Keeps v1 registration names while requiring renderers of rows, never donor framework nodes. */
export function adaptRowPlugin(module: Record<string, unknown>, file: ExtensionFile, navigate?: (name: string) => void, context?: RowPluginContext): Extension {
  const descriptor = record(module.default) ? module.default : module
  const activate = descriptor.activate ?? descriptor.tui
  const name = String(descriptor.id ?? file.plugin?.spec ?? "plugin").replace(/[^\w.-]/g, "_").slice(0, 64)
  return {
    name,
    ...(typeof descriptor.server === "function" || typeof module.default === "function" ? { daemon: () => {} } : {}),
    ...(typeof activate === "function" ? { async tui(api: TuiExtensionAPI) {
      const controller = new AbortController()
      api.onDispose(() => controller.abort())
      let actions: TuiActions | undefined
      const go = (id: string) => actions ? actions.openPage(id) : navigate?.(id)
      const routes = { register(entries: Array<{ name: string; title?: string; render(ctx: SlotContext): Line[] }>) {
        let alive = true
        for (const route of entries) api.page(route.name, { title: route.title ?? route.name, render: (ctx) => alive ? panelGrid({ rows: [[{ title: route.title ?? route.name, body: route.render({ ...ctx, width: Math.max(1, ctx.width - 4), height: Math.max(1, ctx.height - 4) }) as TerminalLine[] }]], width: ctx.width, heights: [ctx.height], compact: ctx.width < 70, padding: true }) : [] })
        return () => { alive = false; api.redraw() }
      }, navigate: go }
      const slots = { register(input: { slots: Record<string, (ctx: SlotContext) => Line[]> }) {
        let alive = true
        for (const [slot, render] of Object.entries(input.slots)) {
          const mapped = SLOTS[slot] ?? (slot.startsWith("sidebar:") ? slot as SlotName : undefined)
          if (!mapped) throw new Error(`unsupported plugin slot: ${slot}`)
          api.slot(mapped, (ctx) => alive ? render(ctx) : undefined)
        }
        return () => { alive = false; api.redraw() }
      } }
      const command = { register(factory: () => Array<{ title: string; value: string; description?: string; slash?: { name: string; aliases?: string[] }; keybind?: string; onSelect?(): void }>) {
        let alive = true
        for (const definition of factory()) {
          const run = (_args: string, next: TuiActions) => { if (alive) { actions = next; try { definition.onSelect?.() } finally { actions = undefined } } }
          for (const key of [definition.slash?.name ?? definition.value, ...definition.slash?.aliases ?? []]) api.command(key, definition.description ?? definition.title, run)
          if (definition.keybind) api.key(definition.keybind, (next) => run("", next))
        }
        return () => { alive = false }
      } }
      const lifecycle = { signal: controller.signal, onDispose(cb: () => void) { api.onDispose(cb); return () => {} } }
      const metadataCall = async (operation: "get" | "list" | "patch", input: { sessionID?: string; patch?: Record<string, unknown> } = {}) => {
        if (!context) throw new Error("plugin metadata requires an attached daemon")
        const patch = input.patch ? JSON.parse(JSON.stringify(input.patch)) as NonNullable<Extract<CommandInput, { type: "plugins.metadata" }>["patch"]> : undefined
        const reply = await context.request({ type: "plugins.metadata", directory: context.directory, plugin: name, operation, ...(operation === "list" ? {} : { sessionId: (input.sessionID ?? context.current()) as SessionId }), ...(patch ? { patch } : {}) })
        if (!reply.ok) throw new Error("plugin metadata request failed")
        return { data: operation === "list" ? reply.result?.entries : reply.result?.metadata }
      }
      const metadata = { current: () => context?.current(), list: () => metadataCall("list"), get: (input: { sessionID?: string } = {}) => metadataCall("get", input), getCurrent: () => metadataCall("get"), patch: (input: { sessionID?: string; patch?: Record<string, unknown> }) => metadataCall("patch", input) }
      const runtime = { setFooter: (render: () => Line[]) => { api.slot("footer.replace", render); return true }, setFooterEntry: (_id: string, render: () => Line[]) => { api.slot("footer.right", render); return true }, setWidget: (id: string, render: (ctx: SlotContext) => Line[], options: { title?: string; placement?: string } = {}) => { api.widget(options.placement === "sessionBottomDock" ? "tray" : "sidebar", id, { title: options.title ?? id, render }); return true } }
      await activate({ ...api, app: { version: context?.version ?? String(api.version), capabilities: ["line-renderers", "slots", "routes", "commands", "message-renderers", "prompt", "widgets", "settings", ...(context ? ["session-metadata"] : [])] }, slots, route: routes, command, lifecycle, metadata, ui: { runtime } }, file.plugin?.options ?? {})
    } } : {}),
  }
}
