import type { MendPublicSlotName, MendSlotRegistration } from "./types"

export const MEND_PUBLIC_TUI_SLOTS: MendPublicSlotName[] = [
  "home_logo",
  "home_prompt",
  "home_prompt_right",
  "home_bottom",
  "home_footer",
  "session_prompt",
  "session_prompt_right",
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
]

export function isMendPublicSlotName(value: string): value is MendPublicSlotName {
  return MEND_PUBLIC_TUI_SLOTS.includes(value as MendPublicSlotName)
}

export function validateMendSlotRegistration(input: MendSlotRegistration) {
  const names = Object.keys(input.slots || {})
  return {
    ok: names.length > 0,
    names,
    publicNames: names.filter(isMendPublicSlotName),
    customNames: names.filter((name) => !isMendPublicSlotName(name)),
  }
}
