import { commandDialogWidth, useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import {
  createContext,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"

type Context = ReturnType<typeof init>
const ctx = createContext<Context>()

export type Slash = {
  name: string
  aliases?: string[]
}

export type CommandOption = DialogSelectOption<string> & {
  keybind?: string
  suggested?: boolean
  slash?: Slash
  onSlash?: (dialog: ReturnType<typeof useDialog>, input: { name: string; arguments: string }) => void
  hidden?: boolean
  enabled?: boolean
}

function init() {
  const root = getOwner()
  const [registrations, setRegistrations] = createSignal<Accessor<CommandOption[]>[]>([])
  const [suspendCount, setSuspendCount] = createSignal(0)
  const dialog = useDialog()
  const keybind = useKeybind()

  const entries = createMemo(() => {
    const all = registrations().flatMap((x) => x())
    return all.map((x) => ({
      ...x,
      keybindLabel: x.keybind ? keybind.print(x.keybind) : undefined,
      footer: x.footer ?? (x.keybind ? keybind.print(x.keybind) : undefined),
    }))
  })

  const isEnabled = (option: CommandOption) => option.enabled !== false
  const isVisible = (option: CommandOption) => isEnabled(option) && !option.hidden

  const visibleOptions = createMemo(() => entries().filter((option) => isVisible(option)))
  const suggestedOptions = createMemo(() =>
    visibleOptions()
      .filter((option) => option.suggested)
      .map((option) => ({
        ...option,
        value: `suggested:${option.value}`,
        category: "Suggested",
      })),
  )
  const suspended = () => suspendCount() > 0

  useKeyboard((evt) => {
    if (suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    for (const option of entries()) {
      if (!isEnabled(option)) continue
      if (option.keybind && keybind.match(option.keybind, evt)) {
        evt.preventDefault()
        option.onSelect?.(dialog)
        return
      }
    }
  })

  const result = {
    trigger(name: string) {
      for (const option of entries()) {
        if (option.value === name) {
          if (!isEnabled(option)) return
          option.onSelect?.(dialog)
          return
        }
      }
    },
    triggerSlash(name: string, args = "") {
      for (const option of visibleOptions()) {
        const slash = option.slash ?? slashFallbacks[option.value]
        if (!slash) continue
        if (slash.name !== name && !slash.aliases?.includes(name)) continue
        if (option.onSlash) option.onSlash(dialog, { name, arguments: args })
        else option.onSelect?.(dialog)
        return true
      }
      return false
    },
    slashes() {
      return visibleOptions().flatMap((option) => {
        const slash = option.slash ?? slashFallbacks[option.value]
        if (!slash) return []
        return {
          display: "/" + slash.name,
          description: option.description ?? option.title,
          aliases: slash.aliases?.map((alias) => "/" + alias),
          onSelect: () => result.trigger(option.value),
        }
      })
    },
    keybinds(enabled: boolean) {
      setSuspendCount((count) => count + (enabled ? -1 : 1))
    },
    suspended,
    show() {
      dialog.replace(() => <DialogCommand options={visibleOptions()} suggestedOptions={suggestedOptions()} />)
      dialog.setSize("command")
    },
    register(cb: () => CommandOption[]) {
      const owner = getOwner() ?? root
      if (!owner) return () => {}

      let list: Accessor<CommandOption[]> | undefined

      // TUI plugins now register commands via an async store that runs outside an active reactive scope.
      // runWithOwner attaches createMemo/onCleanup to this owner so plugin registrations stay reactive and dispose correctly.
      runWithOwner(owner, () => {
        list = createMemo(cb)
        const ref = list
        if (!ref) return
        setRegistrations((arr) => [ref, ...arr])
        onCleanup(() => {
          setRegistrations((arr) => arr.filter((x) => x !== ref))
        })
      })

      if (!list) return () => {}
      let done = false
      return () => {
        if (done) return
        done = true
        const ref = list
        if (!ref) return
        setRegistrations((arr) => arr.filter((x) => x !== ref))
      }
    },
  }
  return result
}

export function useCommandDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useCommandDialog must be used within a CommandProvider")
  }
  return value
}

export function CommandProvider(props: ParentProps) {
  const value = init()
  const dialog = useDialog()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (value.suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    if (keybind.match("command_list", evt)) {
      evt.preventDefault()
      value.show()
      return
    }
  })

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

function DialogCommand(props: { options: CommandOption[]; suggestedOptions: CommandOption[] }) {
  const dimensions = useTerminalDimensions()
  const categoryMode = createMemo(() => {
    const width = Math.min(commandDialogWidth(dimensions().width), dimensions().width - 2)
    if (width < 76) return "tiny"
    if (width < 112) return "compact"
    return "full"
  })
  let ref: DialogSelectRef<string>
  const list = () => {
    const options = ref?.filter ? props.options : [...props.suggestedOptions, ...props.options]
    return commandOptions(options, categoryMode())
  }
  return <DialogSelect ref={(r) => (ref = r)} title="Commands" variant="command" flat={true} options={list()} />
}

const fullCategoryOrder = [
  "Session",
  "Chat",
  "Models",
  "Providers",
  "Memory",
  "Loops",
  "Workspace",
  "Appearance",
  "Access",
  "Tools",
  "Insights",
  "Setup",
  "Developer",
  "System",
]

const compactCategoryOrder = ["Session", "Chat", "Models", "Context", "Tools", "Settings", "System"]
const tinyCategoryOrder = ["Session", "Chat", "Models", "Tools", "System"]
type CommandCategoryMode = "full" | "compact" | "tiny"

const titleOverrides: Record<string, string> = {
  "session.list": "Switch Chat",
  "session.new": "New Chat",
  "session.rename": "Rename Chat",
  "session.compact": "Compact Chat",
  "session.context": "View Context Usage",
  "session.permission.status": "Change Approval Mode",
  "session.toggle.sticky_user_header": "Toggle Sticky User Header",
  "session.toggle.todos": "Toggle Todos",
  "session.toggle.thinking": "Toggle Thinking",
  "session.toggle.timestamps": "Toggle Timestamps",
  "session.toggle.actions": "Toggle Tool Details",
  "session.toggle.conceal": "Toggle Code Preview",
  "session.toggle.scrollbar": "Toggle Chat Scrollbar",
  "session.toggle.generic_tool_output": "Toggle Generic Tool Output",
  "session.timeline": "Jump to Message",
  "session.background": "Detach to Agent View",
  "session.fork": "Fork Chat",
  "session.undo": "Undo Last User Message",
  "session.redo": "Redo Message",
  "session.interrupt": "Interrupt Assistant",
  "session.loop.create": "Create Session Loop Workflow",
  "session.page.up": "Scroll Page Up",
  "session.page.down": "Scroll Page Down",
  "session.line.up": "Scroll Line Up",
  "session.line.down": "Scroll Line Down",
  "session.half.page.up": "Scroll Half Page Up",
  "session.half.page.down": "Scroll Half Page Down",
  "session.first": "Jump to First Message",
  "session.last": "Jump to Last Message",
  "session.messages_last_user": "Jump to Last User Message",
  "session.message.next": "Jump to Next Message",
  "session.message.previous": "Jump to Previous Message",
  "messages.copy": "Copy Last Assistant Reply",
  "session.copy": "Copy Chat Transcript",
  "session.export": "Export Chat Transcript",
  "session.child.first": "Open First Child Chat",
  "session.parent": "Open Parent Chat",
  "session.child.next": "Open Next Child Chat",
  "session.child.previous": "Open Previous Child Chat",
  "workspace.set": "Change Workspace",
  "prompt.clear": "Clear Prompt Input",
  "prompt.submit": "Send Prompt",
  "prompt.editor": "Open Prompt Editor",
  "prompt.editor_context.clear": "Remove Attached Files",
  "prompt.paste": "Paste Clipboard Image",
  "prompt.stash": "Save Prompt Draft",
  "prompt.stash.pop": "Restore Prompt Draft",
  "prompt.stash.list": "Open Prompt Drafts",
  "prompt.skills": "Insert Skill",
  "model.list": "Switch Model",
  "model.cycle_recent": "Cycle Recent Model",
  "model.cycle_recent_reverse": "Cycle Previous Recent Model",
  "model.cycle_favorite": "Cycle Favorite Model",
  "model.cycle_favorite_reverse": "Cycle Previous Favorite Model",
  "agent.list": "Switch Agent",
  "agent.cycle": "Cycle Agent",
  "agent.cycle.reverse": "Cycle Previous Agent",
  "agent.mode.picker": "Switch Agent Mode",
  "mcp.list": "Toggle MCP Servers",
  "variant.list": "Switch Model Variant",
  "variant.cycle": "Cycle Model Variant",
  "provider.connect": "Connect Provider",
  "console.org.switch": "Switch Organization",
  "mendcode.memory.status": "Review Memory Proposals",
  "mendcode.memory.manager": "Open Memory Center",
  "mendcode.memory.input.enable": "Enable Memory Input",
  "mendcode.memory.io.enable": "Enable Memory Input and Output",
  "mendcode.memory.disable": "Disable Memory",
  "mendcode.loops.dashboard": "Open Loop Workflows",
  "mendcode.loop.create": "Create Loop Workflow",
  "mendcode.presentation.profile": "Configure Chat Presentation",
  "mendcode.message.renderer": "Configure Message Rendering",
  "mendcode.prompt.mode": "Switch Prompt Context",
  "mendcode.prompt.chrome": "Configure Chat Input",
  "mendcode.prompt.lead": "Configure Input Marker",
  "mendcode.prompt.status.placement": "Configure Prompt Status Position",
  "mendcode.prompt.status.script.left": "Configure Left Status Script",
  "mendcode.prompt.status.script.right": "Configure Right Status Script",
  "mendcode.prompt.status.left": "Configure Left Status Builtins",
  "mendcode.prompt.status.right": "Configure Right Status Builtins",
  "mendcode.prompt.status.separator": "Configure Status Separator",
  "mendcode.prompt.mode.cycle": "Cycle Prompt Context",
  "mendcode.session.submit_scroll": "Configure Submit Scroll Behavior",
  "mendcode.setup": "Open Setup",
  "mendcode.permission.status": "Change Default Approval Mode",
  "mendcode.status": "View MendCode Health",
  "mendcode.ai.status": "Configure Providers",
  "mendcode.models.status": "Configure Models",
  "mendcode.budget.status": "Configure Budget",
  "mendcode.home.identity": "Configure Home Identity",
  "mendcode.home.title": "Configure Home Title",
  "mendcode.home.font": "Configure Home Font",
  "mendcode.home.logo.text": "Configure Home Mascot",
  "mendcode.home.welcome": "Configure Home Welcome",
  "mendcode.home.split.panel": "Configure Home Split Panel",
  "mendcode.customization.capabilities": "View Customization Capabilities",
  "mendcode.packages": "Manage Packages",
  "mendcode.packages.create": "Create or Update Local Package",
  "mendcode.packages.disableAll": "Disable All Packages",
  "mendcode.marketplace": "Open Marketplace",
  "mendcode.registry.status": "View Package Source Status",
  "mendcode.runtime.status": "View Runtime Status",
  "mendcode.runtime.configure": "Configure Runtime",
  "mendcode.assets": "Manage Project Assets",
  "mendcode.slash.commands": "View Slash Commands",
  "mendcode.tsm.status": "Open TSM Manager",
  "mendcode.worktree.manager": "Manage Worktrees",
  "mendcode.mflow.status": "Open Mflow Manager",
  "mendcode.mflow.activate": "Configure and Enable Mflow",
  "mendcode.mflow.deactivate": "Disable Mflow",
  "mendcode.mflow.remove": "Remove Mflow Config",
  "mendcode.stats.insights": "Open Usage Insights",
  "mendcode.stats.project": "Open Project Usage Insights",
  "mendcode.changes.review": "Review Changes",
  "theme.switch": "Switch Theme",
  "plugins.list": "Manage Internal TUI Plugins",
  "session.v2.messages": "View V2 Session Messages",
  "help.show": "Open Help",
  "docs.open": "Open Docs",
  "app.exit": "Quit MendCode",
  "app.debug": "Toggle Debug Panel",
  "app.console": "Toggle Console",
  "app.heap_snapshot": "Write Heap Snapshot",
  "terminal.suspend": "Suspend Terminal",
}

const slashFallbacks: Record<string, Slash> = {
  "mendcode.permission.status": { name: "permission", aliases: ["permissions", "approval"] },
  "mendcode.status": { name: "health", aliases: ["mend-status"] },
  "mendcode.ai.status": { name: "provider" },
  "mendcode.budget.status": { name: "budget" },
  "mendcode.home.identity": { name: "home" },
  "mendcode.home.welcome": { name: "welcome" },
  "mendcode.runtime.configure": { name: "runtime" },
  "mendcode.registry.status": { name: "registry" },
  "mendcode.slash.commands": { name: "commands" },
  "plugins.list": { name: "plugins" },
  "mendcode.tsm.status": { name: "tsm" },
  "mendcode.worktree.manager": { name: "worktrees" },
  "mendcode.mflow.status": { name: "mflow" },
  "mendcode.mflow.activate": { name: "mflow-on" },
  "mendcode.mflow.deactivate": { name: "mflow-off" },
  "mendcode.mflow.remove": { name: "mflow-remove" },
  "prompt.skills": { name: "skills" },
  "docs.open": { name: "docs" },
  "theme.switch_mode": { name: "theme-mode" },
  "terminal.title.toggle": { name: "terminal-title" },
  "app.toggle.animations": { name: "animations" },
  "app.toggle.file_context": { name: "file-context" },
  "app.toggle.paste_summary": { name: "paste-summary" },
}

function commandCategory(option: CommandOption) {
  const value = String(option.value).replace(/^suggested:/, "")
  if (option.category === "Developer" || option.category === "Debug" || value.includes("debug") || value.includes("heap_snapshot")) {
    return "Developer"
  }
  if (value.includes("memory")) return "Memory"
  if (value.includes("loop")) return "Loops"
  if (value.includes("workspace")) return "Workspace"
  if (
    value.includes("model") ||
    value.includes("agent") ||
    value.includes("variant") ||
    value.includes("mcp") ||
    option.category === "Agent"
  ) {
    return "Models"
  }
  if (
    value === "mendcode.ai.status" ||
    value.includes("provider") ||
    value.includes("org") ||
    option.category === "Provider" ||
    option.category === "Connect Provider"
  ) {
    return "Providers"
  }
  if (value.includes("permission") || value.includes("approval") || value.includes("budget") || option.category === "Permissions") {
    return "Access"
  }
  if (value.startsWith("session.") || value.startsWith("messages.") || option.category === "Session") return "Session"
  if (
    option.category === "Prompt" ||
    value.includes("prompt.") ||
    value.includes("presentation") ||
    value.includes("renderer") ||
    value.includes("submit_scroll") ||
    value.includes("thinking") ||
    value.includes("timestamps") ||
    value.includes("conceal") ||
    value.includes("scrollbar") ||
    value.includes("generic_tool_output")
  ) {
    return "Chat"
  }
  if (
    value.includes("theme") ||
    value.includes("home") ||
    value.includes("customization") ||
    value.includes("terminal.title") ||
    value.includes("animations") ||
    value.includes("paste_summary") ||
    value.includes("directory_filter") ||
    value.includes("diffwrap") ||
    value.startsWith("tips.")
  ) {
    return "Appearance"
  }
  if (
    value.includes("package") ||
    value.includes("marketplace") ||
    value.includes("plugin") ||
    value.includes("skill") ||
    value.includes("asset") ||
    value.includes("runtime") ||
    value.includes("registry") ||
    value.includes("slash.commands") ||
    value.includes("tsm") ||
    value.includes("worktree") ||
    value.includes("mflow")
  ) {
    return "Tools"
  }
  if (value.includes("stats") || value.includes("insights") || value.includes("changes.review")) return "Insights"
  if (value.includes("setup")) return "Setup"
  return "System"
}

function commandCategoryForWidth(option: CommandOption, mode: CommandCategoryMode) {
  const category = commandCategory(option)
  if (mode === "full") return category
  if (mode === "tiny") {
    if (category === "Providers") return "Models"
    if (category === "Memory" || category === "Loops" || category === "Workspace" || category === "Access") return "Tools"
    if (category === "Appearance" || category === "Insights" || category === "Setup" || category === "Developer") return "System"
    return category
  }
  if (category === "Providers") return "Models"
  if (category === "Memory" || category === "Loops" || category === "Workspace") return "Context"
  if (category === "Appearance" || category === "Access" || category === "Setup") return "Settings"
  if (category === "Insights" || category === "Developer") return "System"
  return category
}

function commandRank(option: CommandOption) {
  const priority: Record<string, number> = {
    "session.new": 0,
    "session.list": 1,
    "session.rename": 2,
    "session.timeline": 3,
    "session.compact": 4,
    "session.context": 5,
    "mendcode.memory.status": 20,
    "mendcode.memory.manager": 21,
    "mendcode.loops.dashboard": 22,
    "model.list": 40,
    "agent.list": 41,
    "provider.connect": 42,
    "mcp.list": 60,
    "mendcode.mflow.status": 61,
    "mendcode.tsm.status": 62,
    "mendcode.worktree.manager": 63,
    "mendcode.mflow.activate": 64,
    "mendcode.mflow.deactivate": 65,
    "mendcode.mflow.remove": 66,
    "plugins.list": 67,
    "prompt.skills": 68,
    "theme.switch": 80,
    "help.show": 81,
    "app.exit": 99,
  }
  return priority[option.value] ?? 50
}

function slashText(option: CommandOption) {
  const slash = option.slash ?? slashFallbacks[option.value]
  return slash ? `/${slash.name}` : undefined
}

function searchText(option: CommandOption, keybind?: string) {
  const slash = option.slash ?? slashFallbacks[option.value]
  return [
    option.title,
    titleOverrides[option.value],
    option.category,
    option.description,
    slash ? `/${slash.name}` : undefined,
    ...(slash?.aliases ?? []).map((alias) => `/${alias}`),
    keybind,
  ]
    .filter(Boolean)
    .join(" ")
}

function commandFooter(option: CommandOption): DialogSelectOption<string>["footer"] {
  const keybindLabel = (option as CommandOption & { keybindLabel?: string }).keybindLabel
  const slash = slashText(option)
  if (!slash && !keybindLabel) return option.footer
  return [slash, keybindLabel].filter(Boolean).join("   ")
}

function commandOptions(options: CommandOption[], categoryMode: CommandCategoryMode) {
  const deduped = new Map<string, CommandOption>()
  for (const option of options) {
    const key = String(option.value).replace(/^suggested:/, "")
    if (deduped.has(key) && option.category === "Suggested") continue
    deduped.set(key, option)
  }
  const order = categoryMode === "tiny" ? tinyCategoryOrder : categoryMode === "compact" ? compactCategoryOrder : fullCategoryOrder
  return [...deduped.values()]
    .map((option) => ({
      ...option,
      title: titleOverrides[option.value] ?? option.title,
      category: commandCategoryForWidth(option, categoryMode),
      footer: commandFooter(option),
      searchText: searchText(option, (option as CommandOption & { keybindLabel?: string }).keybindLabel),
    }))
    .toSorted((a, b) => {
      const category = order.indexOf(a.category ?? "") - order.indexOf(b.category ?? "")
      if (category !== 0) return category
      const rank = commandRank(a) - commandRank(b)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title)
    })
}
