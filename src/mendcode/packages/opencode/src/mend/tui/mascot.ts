import type { MendTuiProfile } from "../profile"
import type { MendActivityPhase } from "./presentation"

export type MendLogoMode = "title" | "mascot"
export type MendHomeLogoSize = "compact" | "default" | "large"

export type MendActivityMascotConfig = {
  enabled: boolean
  hover?: string
  states: Partial<Record<MendActivityPhase | "idle" | "error", string>>
}

export type MendMascotLineHitbox = {
  left: number
  text: string
}

function cleanAsciiLiteral(value: string) {
  return value.replace(/^\n/, "").trimEnd()
}

function stripActivityStateText(value: string) {
  return value
    .split("\n")
    .map((line) => line.replace(/([)\]])\s{2,}\S.*$/, "$1"))
    .join("\n")
}

export const defaultHomeMascot = cleanAsciiLiteral(String.raw`
      .-.
     (o o)
    /|[+]|\
   /_|___|_\
      \_/
`)

export const compactHomeMascot = defaultHomeMascot

export const largeHomeMascot = cleanAsciiLiteral(String.raw`
        .-.
     .-(o o)-.
    /  |[+]|  \
   /___|___|___\
       \___/
`)

export const extraLargeHomeMascot = cleanAsciiLiteral(String.raw`
          .-.
      .--(o o)--.
     /    |[+]|    \
    /_____|___|_____\
      ___/_____\___
         \_____/
           \_/
`)

function homeMascotBySize(size: MendHomeLogoSize | undefined) {
  if (size === "compact") return compactHomeMascot
  if (size === "large") return largeHomeMascot
  return defaultHomeMascot
}

export const defaultActivityMascotStates: MendActivityMascotConfig["states"] = {
  idle: String.raw`
  .-.
 (o o)
 /[+]\
`,
  thinking: String.raw`
  .-.
 (o -)
 /[+]\
`,
  planning: String.raw`
  .-.
 (o .)
 /[+]\
`,
  memory: String.raw`
  .-.
 (o m)
 /[+]\
`,
  reading: String.raw`
  .-.
 (o o)
 /[+]\
`,
  searching: String.raw`
  .-.
 (o ?)
 /[+]\
`,
  sending: String.raw`
  .-.
 (* *)
 /[+]\
`,
  patching: String.raw`
  .-.
 (o ^)
 /[+]\
`,
  editing: String.raw`
  .-.
 (o >)
 /[+]\
`,
  running: String.raw`
  .-.
 (o !)
 /[+]\
`,
  installing: String.raw`
  .-.
 ($ $)
 /[+]\
`,
  testing: String.raw`
  .-.
 (o T)
 /[+]\
`,
  browsing: String.raw`
  .-.
 (o @)
 /[+]\
`,
  retrying: String.raw`
  .-.
 (! !)
 /[+]\
`,
  blocked: String.raw`
  .-.
 (- -)
 /[+]\
`,
  done: String.raw`
  .-.
 (^ ^)
 /[+]\
`,
  error: String.raw`
  .-.
 (x x)
 /[+]\
`,
}

for (const [phase, text] of Object.entries(defaultActivityMascotStates)) {
  defaultActivityMascotStates[phase as keyof typeof defaultActivityMascotStates] = cleanAsciiLiteral(text)
}

export const defaultActivityMascotHover = cleanAsciiLiteral(String.raw`
  .-.
 (^ ^)
 /[+]\
`)

export const defaultActivityMascotConfig: MendActivityMascotConfig = {
  enabled: true,
  hover: defaultActivityMascotHover,
  states: defaultActivityMascotStates,
}

export function homeMascotText(profile: MendTuiProfile) {
  return profile.surfaces.homeLogo?.text?.trimEnd() || homeMascotBySize(profile.surfaces.homeLogo?.size)
}

export function activityMascotText(profile: MendTuiProfile, phase: MendActivityPhase | "idle" | "error") {
  if (profile.identity.logoMode !== "mascot") return
  const mascot = profile.presentation.activity.mascot
  if (mascot.enabled === false) return
  const text = mascot.states[phase] || mascot.states.idle || defaultActivityMascotStates[phase] || defaultActivityMascotStates.idle
  return text ? stripActivityStateText(text.trimEnd()) : undefined
}

export function activityMascotHoverText(profile: MendTuiProfile) {
  if (profile.identity.logoMode !== "mascot") return
  const mascot = profile.presentation.activity.mascot
  if (mascot.enabled === false) return
  const text = mascot.hover || defaultActivityMascotHover
  return stripActivityStateText(text.trimEnd())
}

export function mascotTextWidth(...values: Array<string | undefined>) {
  return values.reduce((max, value) => {
    if (!value) return max
    return Math.max(
      max,
      ...value.split("\n").map((line) => line.length),
    )
  }, 0)
}

export function mascotLineHitboxes(value: string): MendMascotLineHitbox[] {
  return value.split("\n").map((line) => {
    const text = line.trimEnd()
    const left = text.search(/\S/)
    if (left === -1) return { left: 0, text: "" }
    return { left, text: text.slice(left) }
  })
}
