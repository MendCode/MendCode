import type { AcpAgentSettings, AcpRegistryEntry, Settings } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type Glyphs, type Line } from "../ui/theme"
import { deck, deckChrome, fit } from "./deck"
import { wrap } from "./wrap"

type Form = { name: string; command: string; args: string; envKeys: string; row: number; editing?: string; error?: string }
export type AcpPageState = { selected: number; form?: Form; removing?: string; error?: string; loading?: boolean; registry?: { agents: AcpRegistryEntry[]; selected: number } }
export type AcpAction = { type: "none" | "close" | "refresh" | "registry" } | { type: "registry-add"; agentId: string } | { type: "save"; name: string; config: AcpAgentSettings } | { type: "remove"; name: string }
const NONE: AcpAction = { type: "none" }
const FIELDS = ["name", "command", "args", "envKeys"] as const
const UP = new Set(["\x1b[A", "\x1bOA", "\x10"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "\t"])

export const createAcpPageState = (): AcpPageState => ({ selected: 0 })

export function acpPageKey(state: AcpPageState, key: string, agents: NonNullable<Settings["acpAgents"]>): { state: AcpPageState; action: AcpAction } {
  const names = Object.keys(agents).sort()
  const selected = Math.max(0, Math.min(state.selected, names.length - 1))
  const result = (next: AcpPageState, action: AcpAction = NONE) => ({ state: next, action })
  if (state.registry) {
    const registry = state.registry
    const index = Math.max(0, Math.min(registry.selected, registry.agents.length - 1))
    if (key === "\x1b" || key === "q") return result({ selected })
    if (key === "r") return result(state, { type: "registry" })
    if (UP.has(key) || key === "k") return result({ ...state, registry: { ...registry, selected: Math.max(0, index - 1) } })
    if (DOWN.has(key) || key === "j") return result({ ...state, registry: { ...registry, selected: Math.min(Math.max(0, registry.agents.length - 1), index + 1) } })
    const agent = registry.agents[index]
    if (key === "\r" && agent && !agent.configured) return result(state, { type: "registry-add", agentId: agent.id })
    return result(state)
  }
  if (state.removing) {
    if (key === "y") return result({ selected }, { type: "remove", name: state.removing })
    if (key === "n" || key === "\x1b") return result({ selected })
    return result(state)
  }
  if (state.form) {
    const form = state.form
    if (key === "\x1b") return result({ selected })
    if (UP.has(key)) return result({ ...state, form: { ...form, row: Math.max(form.editing ? 1 : 0, form.row - 1) } })
    if (DOWN.has(key)) return result({ ...state, form: { ...form, row: Math.min(4, form.row + 1) } })
    if (key === "\r") {
      if (form.row < 4) return result({ ...state, form: { ...form, row: form.row + 1 } })
      let args: unknown
      try { args = JSON.parse(form.args || "[]") } catch { args = undefined }
      const envKeys = form.envKeys.split(/[\s,]+/).filter(Boolean)
      const error = !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(form.name) ? "invalid name"
        : !form.editing && agents[form.name] ? "name already exists"
        : !form.command.trim() ? "command is required"
        : !Array.isArray(args) || args.length > 200 || args.some((arg) => typeof arg !== "string" || arg.length > 4096) ? "args must be a JSON string array"
        : envKeys.length > 200 || envKeys.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ? "env keys only: KEY, OTHER_KEY" : undefined
      if (error) return result({ ...state, form: { ...form, error } })
      return result(state, { type: "save", name: form.name, config: { command: form.command.trim(), args: args as string[], envKeys: [...new Set(envKeys)] } })
    }
    const field = FIELDS[form.row]
    if (!field || (field === "name" && form.editing)) return result(state)
    if (key === "\x7f" || key === "\b") return result({ ...state, form: { ...form, [field]: form[field].slice(0, -1) } })
    if (field === "envKeys" && !/^[A-Za-z0-9_, ]+$/.test(key)) return result({ ...state, form: { ...form, error: "env keys only; values are never entered here" } })
    if (/^[^\x00-\x1f\x7f]+$/u.test(key)) return result({ ...state, form: { ...form, [field]: (form[field] + key).slice(0, field === "name" ? 64 : field === "command" ? 4096 : 60000) } })
    return result(state)
  }
  if (key === "\x1b" || key === "q") return result(state, { type: "close" })
  if (UP.has(key) || key === "k") return result({ ...state, selected: Math.max(0, selected - 1) })
  if (DOWN.has(key) || key === "j") return result({ ...state, selected: Math.min(Math.max(0, names.length - 1), selected + 1) })
  if (key === "r") return result(state, { type: "refresh" })
  if (key === "c") return result(state, { type: "registry" })
  if (key === "a") return result({ selected, form: { name: "", command: "", args: "[]", envKeys: "", row: 0 } })
  const name = names[selected]
  if (key === "e" && name) {
    const config = agents[name]!
    return result({ selected, form: { name, editing: name, command: config.command, args: JSON.stringify(config.args ?? []), envKeys: (config.envKeys ?? []).join(", "), row: 1 } })
  }
  if (key === "d" && name) return result({ selected, removing: name })
  return result(state)
}

export function renderAcpPage(input: { state: AcpPageState; agents: NonNullable<Settings["acpAgents"]>; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { state, agents, width, height } = input
  const g = input.glyphs ?? defaultGlyphs()
  const names = Object.keys(agents).sort()
  const selected = Math.max(0, Math.min(state.selected, names.length - 1))
  const hints = state.registry ? "↑↓ select · enter add · r refresh PATH · esc back" : state.removing ? "y remove · n/esc cancel" : state.form ? "↑↓ row · enter next/save · esc cancel" : "↑↓ select · c catalog · a custom · e edit · d remove · r refresh · esc back"
  const inner = Math.max(1, width - 2)
  const line = (text: string, fg: "body" | "muted" | "primary" | "error" = "body"): Line => fit([{ text, fg }], inner)
  const body: Line[] = state.registry ? [] : [line("New sessions use edits · native engine", "muted"), line("Running agents: restart to apply", "muted"), []]
  if (state.loading) body.push(line("loading agents…", "muted"))
  else if (state.registry) {
    const { agents: entries, selected: index } = state.registry
    const agent = entries[index]
    const details: Line[] = agent ? [[], ...wrap(`Install: ${agent.install}`, inner).map((text) => line(text)), ...wrap(agent.website, inner).map((text) => line(text, "muted")), ...wrap(`Run: ${JSON.stringify([agent.command, ...agent.args])}`, inner).map((text) => line(text)), line("Sign in with the agent's own CLI.", "muted"), line("PATH only; auth unchecked.", "muted"), line(agent.configured ? "Already added · edit in /acp" : "Enter adds config only; no launch", "muted")] : [line("no catalog entries", "muted")]
    const room = Math.max(1, height - deckChrome(hints, width) - details.length - (state.error ? 1 : 0))
    const start = Math.max(0, index - room + 1)
    for (const [offset, agent] of entries.slice(start, start + room).entries()) {
      body.push(line(`${start + offset === index ? g.user : " "} ${agent.name} · ${agent.installed ? "installed" : "missing"}${agent.configured ? " · added" : ""}`, start + offset === index ? "primary" : "body"))
    }
    body.push(...details)
  } else if (state.form) {
    const form = state.form
    body.push(line(form.editing ? `Edit ${form.name} · name is fixed` : "Add ACP agent", "primary"))
    for (let row = 0; row <= 4; row++) {
      const field = FIELDS[row]
      const label = field === "args" ? "args (JSON)" : field === "envKeys" ? "env keys" : field
      body.push(line(`${row === form.row ? g.user : " "} ${field ? `${label}: ${form[field]}${row === form.row ? "▏" : ""}` : "Save"}`, row === form.row ? "primary" : "body"))
    }
    body.push([], line("Env values stay private; new keys use the daemon environment.", "muted"))
    if (form.error) body.push(line(form.error, "error"))
  } else {
    const room = Math.max(1, height - deckChrome(hints, width) - 9)
    const start = Math.max(0, selected - room + 1)
    for (const [offset, name] of names.slice(start, start + room).entries()) body.push(line(`${start + offset === selected ? g.user : " "} ${name} · ${agents[name]!.command}`, start + offset === selected ? "primary" : "body"))
    if (!names.length) body.push(line("no ACP agents · a to add", "muted"))
    const config = names[selected] ? agents[names[selected]!] : undefined
    if (config) body.push([], line(`args: ${JSON.stringify(config.args ?? [])}`), line(`env keys: ${(config.envKeys ?? []).join(", ") || "none"}`, "muted"))
    if (state.removing) body.push([], line(`Remove ${state.removing}?`, "error"))
  }
  if (state.error) body.push(line(state.error, "error"))
  return deck({ page: "ACP agents", subtitle: state.registry ? "offline catalog" : "configuration", summary: `${names.length} configured`, body, hints, width, height })
}
