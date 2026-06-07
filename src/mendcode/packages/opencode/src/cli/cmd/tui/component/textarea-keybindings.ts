import { createMemo } from "solid-js"
import type { KeyBinding, ParsedKey } from "@opentui/core"
import { useKeybind } from "../context/keybind"
import { Keybind } from "@/util/keybind"

const TEXTAREA_ACTIONS = [
  "submit",
  "newline",
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
] as const

function mapTextareaKeybindings(
  keybinds: Record<string, Keybind.Info[]>,
  action: (typeof TEXTAREA_ACTIONS)[number],
): KeyBinding[] {
  const configKey = `input_${action.replace(/-/g, "_")}`
  const bindings = keybinds[configKey]
  if (!bindings) return []
  return bindings.map((binding) => ({
    name: binding.name,
    ctrl: binding.ctrl || undefined,
    meta: binding.meta || undefined,
    shift: binding.shift || undefined,
    super: binding.super || undefined,
    action,
  }))
}

export function textareaKeybindingsFromConfig(keybinds: Record<string, Keybind.Info[]>): KeyBinding[] {
  const newline = mapTextareaKeybindings(keybinds, "newline")
  return [
    ...newline,
    { name: "return", shift: true, action: "newline" },
    { name: "return", ctrl: true, action: "newline" },
    { name: "return", meta: true, action: "newline" },
    { name: "j", ctrl: true, action: "newline" },
    { name: "return", action: "submit" },
    ...TEXTAREA_ACTIONS.filter((action) => action !== "newline").flatMap((action) =>
      mapTextareaKeybindings(keybinds, action),
    ),
  ] satisfies KeyBinding[]
}

export function isTextareaNewlineKey(evt: ParsedKey, keybinds: Record<string, Keybind.Info[]>): boolean {
  const parsed = Keybind.fromParsedKey(evt)
  const configuredNewline = keybinds.input_newline ?? []
  if (configuredNewline.some((binding) => Keybind.match(binding, parsed))) return true

  return (
    (evt.name === "return" && (evt.shift === true || evt.ctrl === true || evt.meta === true)) ||
    (evt.name === "j" && evt.ctrl === true)
  )
}

export function useTextareaKeybindings() {
  const keybind = useKeybind()

  return createMemo(() => {
    return textareaKeybindingsFromConfig(keybind.all)
  })
}
