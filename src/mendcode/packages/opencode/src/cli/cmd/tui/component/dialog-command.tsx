import { useDialog } from "@tui/ui/dialog"
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
import { useKeyboard } from "@opentui/solid"
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
  let ref: DialogSelectRef<string>
  const list = () => {
    const options = ref?.filter ? props.options : [...props.suggestedOptions, ...props.options]
    return commandOptions(options)
  }
  return <DialogSelect ref={(r) => (ref = r)} title="Commands" variant="command" flat={true} options={list()} />
}

const categoryOrder = ["Session", "Chat", "Models", "Context", "Tools", "Settings", "System"]

const titleOverrides: Record<string, string> = {
  "session.list": "Open chats",
  "session.new": "New chat",
  "session.rename": "Rename",
  "session.compact": "Summarize",
  "session.permission.status": "Approval",
  "session.toggle.todos": "Todos",
  "session.toggle.thinking": "Thinking",
  "session.toggle.timestamps": "Timestamps",
  "session.toggle.actions": "Tool details",
  "session.toggle.conceal": "Code preview",
  "session.toggle.scrollbar": "Scrollbar",
  "session.toggle.generic_tool_output": "Tool output",
  "session.timeline": "Timeline",
  "session.background": "Run in background",
  "session.attach": "Attach",
  "session.fork": "Fork chat",
  "session.undo": "Undo",
  "session.redo": "Redo",
  "messages.copy": "Copy reply",
  "session.copy": "Copy chat",
  "session.export": "Export chat",
  "workspace.set": "Workspace",
  "prompt.clear": "Clear input",
  "prompt.submit": "Send",
  "prompt.editor": "Editor",
  "prompt.editor_context.clear": "Clear files",
  "prompt.paste": "Paste",
  "prompt.stash": "Save draft",
  "prompt.stash.pop": "Restore draft",
  "prompt.stash.list": "Drafts",
  "prompt.skills": "Skills",
  "model.list": "Model",
  "agent.list": "Agent",
  "mcp.list": "MCP",
  "variant.list": "Variant",
  "provider.connect": "Provider",
  "console.org.switch": "Organization",
  "mendcode.memory.status": "Memory",
  "mendcode.memory.manager": "Memory",
  "mendcode.memory.input.enable": "Use memory",
  "mendcode.memory.io.enable": "Save memories",
  "mendcode.memory.disable": "Disable memory",
  "mendcode.presentation.profile": "Chat view",
  "mendcode.prompt.mode": "Prompt context",
  "mendcode.prompt.chrome": "Chat input",
  "mendcode.prompt.lead": "Input marker",
  "mendcode.prompt.status.placement": "Status position",
  "mendcode.prompt.status.script.left": "Left script",
  "mendcode.prompt.status.script.right": "Right script",
  "mendcode.prompt.status.left": "Left status",
  "mendcode.prompt.status.right": "Right status",
  "mendcode.prompt.status.separator": "Status separator",
  "mendcode.prompt.mode.cycle": "Next prompt context",
  "mendcode.setup": "Setup",
  "mendcode.permission.status": "Permissions",
  "mendcode.status": "Health",
  "mendcode.ai.status": "Provider setup",
  "mendcode.models.status": "Model setup",
  "mendcode.budget.status": "Budget",
  "mendcode.home.identity": "Home",
  "mendcode.home.title": "Home title",
  "mendcode.home.font": "Home font",
  "mendcode.home.logo.size": "Home mascot",
  "mendcode.home.welcome": "Welcome",
  "mendcode.home.split.panel": "Home panel",
  "mendcode.customization.capabilities": "Customization",
  "mendcode.packages": "Packages",
  "mendcode.packages.create": "Create package",
  "mendcode.packages.disableAll": "Disable packages",
  "mendcode.marketplace": "Marketplace",
  "mendcode.registry.status": "Package source",
  "mendcode.runtime.status": "Runtime",
  "mendcode.runtime.configure": "Use runtime",
  "mendcode.assets": "Project assets",
  "mendcode.slash.commands": "Commands",
  "mendcode.tsm.status": "TSM",
  "mendcode.worktree.manager": "Worktrees",
  "mendcode.mflow.status": "Mflow",
  "mendcode.mflow.activate": "Mflow on",
  "mendcode.mflow.deactivate": "Mflow off",
  "mendcode.mflow.remove": "Mflow remove",
  "theme.switch": "Theme",
  "theme.switch_mode": "Theme mode",
  "theme.mode.lock": "Lock theme",
  "terminal.title.toggle": "Terminal title",
  "app.toggle.animations": "Animations",
  "app.toggle.file_context": "File context",
  "app.toggle.paste_summary": "Paste summary",
  "app.toggle.session_directory_filter": "Directory filter",
  "app.toggle.diffwrap": "Diff wrapping",
  "plugins.list": "Plugins",
  "help.show": "Help",
  "docs.open": "Docs",
  "app.exit": "Quit",
  "app.debug": "Debug panel",
  "app.console": "Console",
  "app.heap_snapshot": "Heap snapshot",
}

const slashFallbacks: Record<string, Slash> = {
  "mendcode.permission.status": { name: "permissions" },
  "mendcode.status": { name: "status" },
  "mendcode.ai.status": { name: "provider" },
  "mendcode.models.status": { name: "models" },
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
  if (option.category === "Suggested") return "System"
  if (option.value.startsWith("session.") || option.category === "Session" || option.category === "Permissions") {
    return "Session"
  }
  if (
    option.value.includes("package") ||
    option.value.includes("marketplace") ||
    option.value.includes("plugin") ||
    option.value.includes("skill") ||
    option.value.includes("mcp") ||
    option.value.includes("asset") ||
    option.value.includes("runtime") ||
    option.value.includes("registry") ||
    option.value.includes("slash.commands") ||
    option.value.includes("tsm") ||
    option.value.includes("worktree") ||
    option.value.includes("mflow")
  ) {
    return "Tools"
  }
  if (
    option.category === "Prompt" ||
    option.value.includes("prompt.") ||
    option.value.includes("presentation") ||
    option.value.includes("thinking") ||
    option.value.includes("timestamps") ||
    option.value.includes("conceal") ||
    option.value.includes("scrollbar") ||
    option.value.includes("generic_tool_output")
  ) {
    return "Chat"
  }
  if (
    option.value.includes("memory") ||
    option.value.includes("context") ||
    option.value.includes("workspace") ||
    option.value.includes("file_context")
  ) {
    return "Context"
  }
  if (
    option.category === "Agent" ||
    option.category === "Provider" ||
    option.value.includes("model") ||
    option.value.includes("agent") ||
    option.value.includes("provider") ||
    option.value.includes("variant")
  ) {
    return "Models"
  }
  if (
    option.value.includes("theme") ||
    option.value.includes("home") ||
    option.value.includes("setup") ||
    option.value.includes("budget") ||
    option.value.includes("permission") ||
    option.value.includes("terminal.title") ||
    option.value.includes("animations") ||
    option.value.includes("paste_summary") ||
    option.value.includes("directory_filter") ||
    option.value.includes("diffwrap")
  ) {
    return "Settings"
  }
  return "System"
}

function commandRank(option: CommandOption) {
  const priority: Record<string, number> = {
    "session.new": 0,
    "session.list": 1,
    "session.rename": 2,
    "session.timeline": 3,
    "session.compact": 4,
    "mendcode.memory.manager": 20,
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
    option.value,
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

function commandOptions(options: CommandOption[]) {
  const deduped = new Map<string, CommandOption>()
  for (const option of options) {
    const key = String(option.value).replace(/^suggested:/, "")
    if (deduped.has(key) && option.category === "Suggested") continue
    deduped.set(key, option)
  }
  return [...deduped.values()]
    .map((option) => ({
      ...option,
      title: titleOverrides[option.value] ?? option.title,
      category: commandCategory(option),
      footer: commandFooter(option),
      searchText: searchText(option, (option as CommandOption & { keybindLabel?: string }).keybindLabel),
    }))
    .toSorted((a, b) => {
      const category = categoryOrder.indexOf(a.category ?? "") - categoryOrder.indexOf(b.category ?? "")
      if (category !== 0) return category
      const rank = commandRank(a) - commandRank(b)
      if (rank !== 0) return rank
      return a.title.localeCompare(b.title)
    })
}
