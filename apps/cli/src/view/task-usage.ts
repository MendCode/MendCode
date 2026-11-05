import type { TaskRecord } from "@mendcode/protocol"
import { compact } from "./format"

/** Shared with the live agent strip; reading a child's usage must not load the Tasks page. */
export function taskUsage(stats: NonNullable<TaskRecord["stats"]>): string {
  return [`${compact(stats.input)} in`, `${compact(stats.output)} out`, ...(stats.costMicros ? [`$${(stats.costMicros / 1e6).toFixed(2)}`] : [])].join(" · ")
}
