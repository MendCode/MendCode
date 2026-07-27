import type { MendTuiProfile } from "@/mend/profile"
import { homeMascotText } from "@/mend/tui/mascot"
import { renderAsciiText, type HomeLogoFont } from "../component/ascii-text"

export type SessionExitSummaryUsage = {
  usage?: string
  model?: string
  provider?: string
  agent?: string
  elapsed?: string
  compaction?: string
}

export type SessionExitSummaryInput = {
  profile: MendTuiProfile
  width: number
  sessionTitle?: string
  sessionID?: string
  usage?: SessionExitSummaryUsage
}

function cleanLines(value: string | undefined) {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function lineWidth(value: string) {
  return Bun.stringWidth(value.replace(/\x1b\[[0-9;]*m/g, ""))
}

function maxWidth(lines: string[]) {
  return lines.reduce((max, line) => Math.max(max, lineWidth(line)), 0)
}

function padRight(value: string, width: number) {
  return `${value}${" ".repeat(Math.max(0, width - lineWidth(value)))}`
}

function combineColumns(left: string[], right: string[], gap = "  ") {
  const leftWidth = maxWidth(left)
  const rows = Math.max(left.length, right.length)
  return Array.from({ length: rows }, (_, index) => `${padRight(left[index] ?? "", leftWidth)}${gap}${right[index] ?? ""}`.trimEnd())
}

function truncate(value: string, width: number) {
  if (width <= 1) return ""
  if (lineWidth(value) <= width) return value
  const chars = [...value]
  let result = ""
  for (const char of chars) {
    if (lineWidth(`${result}${char}…`) > width) break
    result += char
  }
  return `${result}…`
}

function productAscii(profile: MendTuiProfile) {
  return cleanLines(renderAsciiText(profile.identity.productName || "MendCode", profile.identity.logoFont as HomeLogoFont | undefined))
}

function mascotAscii(profile: MendTuiProfile) {
  const explicit = profile.surfaces.homeLogo?.text?.trimEnd()
  if (explicit) return cleanLines(explicit)
  if ((profile.identity.logoMode || "title") === "mascot") return cleanLines(homeMascotText(profile))
  return []
}

function identityLines(input: SessionExitSummaryInput) {
  const width = Math.max(24, input.width)
  const name = input.profile.identity.productName || "MendCode"
  if (width < 54) return [name]

  const title = productAscii(input.profile)
  const mascot = mascotAscii(input.profile)
  if (!mascot.length) return title

  if (width >= maxWidth(mascot) + maxWidth(title) + 4) return combineColumns(mascot, title, "   ")
  if (width >= Math.max(maxWidth(mascot), maxWidth(title)) + 2) return [...mascot, "", ...title]
  return [name]
}

function usageRows(usage: SessionExitSummaryUsage | undefined) {
  if (!usage) return []
  return [
    usage.usage ? ["Usage", usage.usage] : undefined,
    usage.compaction ? ["Context", usage.compaction] : undefined,
    usage.model ? ["Model", usage.model] : undefined,
    usage.provider ? ["Provider", usage.provider] : undefined,
    usage.agent ? ["Agent", usage.agent] : undefined,
    usage.elapsed ? ["Elapsed", usage.elapsed] : undefined,
  ].filter((item): item is [string, string] => Boolean(item))
}

export function renderSessionExitSummary(input: SessionExitSummaryInput) {
  const width = Math.max(24, input.width)
  const details: Array<[string, string]> = [
    input.sessionTitle ? ["Session", input.sessionTitle] : undefined,
    input.sessionID ? ["Continue", `mendcode -s ${input.sessionID}`] : undefined,
    ...usageRows(input.usage),
  ].filter((item): item is [string, string] => Boolean(item))
  const labelWidth = Math.min(10, Math.max(7, ...details.map(([label]) => label.length)))
  const valueWidth = Math.max(8, width - labelWidth - 4)
  const detailLines = details.map(([label, value]) => `  ${label.padEnd(labelWidth)} ${truncate(value, valueWidth)}`)
  return [...identityLines(input).map((line) => `  ${line}`), "", ...detailLines, ""].join("\n")
}
