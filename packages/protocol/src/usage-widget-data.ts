/** Data-only widget IDs: safe for terminal profiles and the startup graph. */
export const USAGE_WIDGET_IDS = ["token-mix", "response-load", "subscription-usage", "peak-pressure", "clock", "weather", "status", "outcome-signals", "tools", "agents-models"] as const
export type UsageWidgetId = (typeof USAGE_WIDGET_IDS)[number]

export function normalizeUsageWidgets(raw: unknown): UsageWidgetId[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is UsageWidgetId => typeof id === "string" && USAGE_WIDGET_IDS.includes(id as UsageWidgetId)))] : []
}
