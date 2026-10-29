import type { Line } from "../ui/theme"

export const STATUS_BUILTINS = ["mode", "model", "provider", "reasoning", "variant", "context", "permissionMode", "commandsHint", "agentsHint", "quota"] as const
export function statusItems(order: string, colors: string, values: Partial<Record<(typeof STATUS_BUILTINS)[number], string>>, separator: string): Line {
  let palette: Record<string, string> = {}
  try { palette = JSON.parse(colors || "{}") } catch {}
  const out: Line = []
  for (const name of order.split(",").map((name) => name.trim())) {
    const value = values[name as keyof typeof values]
    if (!value) continue
    if (out.length) out.push({ text: separator, fg: "muted" })
    const color = palette[name]
    out.push({ text: value, ...(color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? { fgHex: color } : { fg: name === "mode" ? "primary" as const : "text" as const }) })
  }
  return out
}
