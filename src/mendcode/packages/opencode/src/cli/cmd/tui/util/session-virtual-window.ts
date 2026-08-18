// Keep a bounded transcript window mounted; large reopened sessions can otherwise exhaust RAM before the UI becomes interactive.
// Overscan is measured in terminal rows because one message can be one row or hundreds of rows.
// Keep the normal reopened-session path fully mounted. Virtualize only larger
// histories, where the bounded window materially reduces memory and layout work.
export const SESSION_MESSAGE_VIRTUALIZATION_THRESHOLD = 200
export const SESSION_MESSAGE_VIRTUAL_OVERSCAN = 36
export const SESSION_MESSAGE_ESTIMATED_HEIGHT = 6
// Sync keeps at most 150 transcript rows loaded. The window may need that full
// bounded set when many rows intentionally render at zero height (for example,
// compacted/reverted assistant records); a lower item-count cap can leave only
// invisible rows mounted and expose the prefix spacer as an empty viewport.
export const SESSION_MESSAGE_MAX_MOUNTED = 150

export type SessionVirtualWindow = {
  start: number
  end: number
  topSpacer: number
  bottomSpacer: number
  virtualized: boolean
}

export type SessionScrollAnchor = {
  id: string
  offset: number
}

export function sessionScrollAnchor(input: {
  children: readonly { id?: string; y: number; height?: number }[]
  top: number
  viewportHeight: number
  transcriptChildIDs: ReadonlySet<string>
}) {
  const child = input.children
    .filter((item) => {
      if (!item.id || !input.transcriptChildIDs.has(item.id)) return false
      const bottom = item.y + Math.max(1, item.height ?? 0)
      return item.y < input.top + Math.max(1, input.viewportHeight) && bottom > input.top
    })
    .sort((a, b) => a.y - b.y)[0]
  return child?.id ? ({ id: child.id, offset: child.y - input.top } satisfies SessionScrollAnchor) : undefined
}

// OpenTUI can report zero while a newly mounted child is being reconciled. Keep
// a known positive measurement, otherwise leave the row unknown so the
// virtualizer can use its estimate instead of collapsing document geometry.
export function sessionMeasuredHeight(observedHeight: number, previousHeight?: number) {
  const height = Number.isFinite(observedHeight) ? Math.max(0, Math.ceil(observedHeight)) : 0
  if (height > 0) return height
  if (previousHeight !== undefined && previousHeight > 0) return previousHeight
  return undefined
}

export function sessionMessageVirtualWindow(input: {
  total: number
  scrollTop: number
  viewportHeight: number
  followOutput: boolean
  anchorIndex?: number
  threshold?: number
  overscan?: number
  estimatedMessageHeight?: number
  itemHeights?: readonly (number | undefined)[]
  maxMounted?: number
}): SessionVirtualWindow {
  const total = Math.max(0, Math.floor(input.total))
  const threshold = input.threshold ?? SESSION_MESSAGE_VIRTUALIZATION_THRESHOLD
  const estimatedMessageHeight = Math.max(1, input.estimatedMessageHeight ?? SESSION_MESSAGE_ESTIMATED_HEIGHT)
  if (total <= threshold) return { start: 0, end: total, topSpacer: 0, bottomSpacer: 0, virtualized: false }

  const overscan = Math.max(0, input.overscan ?? SESSION_MESSAGE_VIRTUAL_OVERSCAN)
  const viewportHeight = Math.max(1, Math.ceil(input.viewportHeight))
  const maxMounted = Math.max(1, Math.floor(input.maxMounted ?? SESSION_MESSAGE_MAX_MOUNTED))
  // A mounted OpenTUI child can briefly report height 0 while it is being
  // reconciled. Keep the measurement for spacer math, but never let a
  // zero-height tail consume the bounded mounted range: follow mode must keep
  // the last rows that can actually occupy the viewport mounted.
  const measuredHeights = Array.from({ length: total }, (_, index) =>
    Math.max(0, input.itemHeights?.[index] ?? estimatedMessageHeight),
  )
  // During an OpenTUI reconciliation pass every mounted child can report 0
  // for one frame. Treat that snapshot as "not measured"; otherwise the
  // virtualizer computes a zero-height document and can mount an empty screen
  // (especially after reopening a long session).
  const heights = measuredHeights.some((height) => height > 0)
    ? measuredHeights
    : Array.from({ length: total }, () => estimatedMessageHeight)
  const lastPositiveIndex = heights.findLastIndex((height) => height > 0)
  const offsets = new Float64Array(total + 1)
  for (let index = 0; index < total; index++) offsets[index + 1] = offsets[index]! + heights[index]!
  const totalHeight = offsets[total]!

  const lowerBound = (row: number) => {
    let left = 0
    let right = total
    while (left < right) {
      const middle = (left + right) >> 1
      if (offsets[middle + 1]! <= row) left = middle + 1
      else right = middle
    }
    return left
  }

  let start: number
  let end: number
  if (input.followOutput && total <= maxMounted) {
    // The sync layer already bounds reopened transcripts to this size. Keep the
    // whole bounded tail mounted so zero-height historical rows cannot delay
    // discovery of the visible rows that must fill the viewport.
    start = 0
    end = total
  } else if (input.followOutput) {
    const target = Math.max(0, totalHeight - viewportHeight - overscan)
    start = lowerBound(target)
    end = total
  } else {
    const scrollTop = Math.max(0, input.scrollTop)
    start = lowerBound(Math.max(0, scrollTop - overscan))
    end = lowerBound(Math.min(totalHeight, scrollTop + viewportHeight + overscan)) + 1
  }

  const anchorIndex =
    input.anchorIndex === undefined ? undefined : Math.min(total - 1, Math.max(0, Math.floor(input.anchorIndex)))
  if (anchorIndex !== undefined && (anchorIndex < start || anchorIndex >= end)) {
    const anchorTop = offsets[anchorIndex]!
    // Keep the physical viewport mounted while also bringing the identity
    // anchor into the same contiguous window. Shifting the entire window to
    // the anchor leaves a large top spacer at scrollTop=0 during the brief
    // period before the restore call can adjust the scroll position.
    start = Math.min(start, lowerBound(Math.max(0, anchorTop - overscan)))
    end = Math.max(
      end,
      lowerBound(Math.min(totalHeight, offsets[anchorIndex + 1]! + viewportHeight + overscan)) + 1,
    )
  }

  // Rows after the last positive measurement have no layout height. Mounting
  // them preferentially can hide every visible row behind an empty tail. The
  // bounded follow tail is the exception: keep all of it mounted while layout
  // settles so a transient zero measurement cannot remove the current chat.
  if (
    !(input.followOutput && total <= maxMounted) &&
    lastPositiveIndex >= 0 &&
    lastPositiveIndex + 1 < end
  ) {
    end = lastPositiveIndex + 1
    if (start >= end) start = Math.max(0, end - maxMounted)
  }

  start = Math.min(start, total)
  end = Math.max(start, Math.min(total, end))
  if (end - start > maxMounted) {
    if (input.followOutput) start = end - maxMounted
    else if (anchorIndex !== undefined && anchorIndex >= start + maxMounted) start = anchorIndex - maxMounted + 1
    end = Math.min(total, start + maxMounted)
  }

  return {
    start,
    end,
    topSpacer: offsets[start]!,
    bottomSpacer: totalHeight - offsets[end]!,
    virtualized: true,
  }
}

export function stickyUserIDFromVirtualWindow<Message extends { id: string }>(input: {
  messages: readonly Message[]
  window: Pick<SessionVirtualWindow, "start">
  mountedUserAnchors: Array<{ id: string; y: number }>
  top: number
  isUser: (message: Message) => boolean
}) {
  const mounted = [...input.mountedUserAnchors].sort((a, b) => a.y - b.y).reverse().find((item) => item.y <= input.top)
  if (mounted) return mounted.id

  for (let index = Math.min(input.window.start - 1, input.messages.length - 1); index >= 0; index--) {
    const message = input.messages[index]
    if (message && input.isUser(message)) return message.id
  }

  return undefined
}
