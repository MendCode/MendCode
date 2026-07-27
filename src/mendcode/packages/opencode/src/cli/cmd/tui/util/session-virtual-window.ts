// Keep a bounded transcript window mounted; large reopened sessions can otherwise exhaust RAM before the UI becomes interactive.
// The threshold decides when to virtualize; the mounted range itself stays viewport-sized plus overscan.
export const SESSION_MESSAGE_VIRTUALIZATION_THRESHOLD = 200
export const SESSION_MESSAGE_VIRTUAL_OVERSCAN = 12
export const SESSION_MESSAGE_ESTIMATED_HEIGHT = 6

export type SessionVirtualWindow = {
  start: number
  end: number
  topSpacer: number
  bottomSpacer: number
  virtualized: boolean
}

export function sessionMessageVirtualWindow(input: {
  total: number
  scrollTop: number
  viewportHeight: number
  followOutput: boolean
  threshold?: number
  overscan?: number
  estimatedMessageHeight?: number
}): SessionVirtualWindow {
  const total = Math.max(0, Math.floor(input.total))
  const threshold = input.threshold ?? SESSION_MESSAGE_VIRTUALIZATION_THRESHOLD
  const estimatedMessageHeight = Math.max(1, input.estimatedMessageHeight ?? SESSION_MESSAGE_ESTIMATED_HEIGHT)
  if (total <= threshold) return { start: 0, end: total, topSpacer: 0, bottomSpacer: 0, virtualized: false }

  const overscan = Math.max(0, input.overscan ?? SESSION_MESSAGE_VIRTUAL_OVERSCAN)
  const viewportCount = Math.max(
    1,
    Math.ceil(Math.max(1, input.viewportHeight)),
    Math.ceil(Math.max(1, input.viewportHeight) / estimatedMessageHeight),
  )
  const windowSize = Math.min(total, viewportCount + overscan * 2)
  const roughTopIndex = Math.max(0, Math.floor(Math.max(0, input.scrollTop) / estimatedMessageHeight))
  const start = input.followOutput ? Math.max(0, total - windowSize) : Math.min(Math.max(0, roughTopIndex - overscan), Math.max(0, total - windowSize))
  const end = Math.min(total, start + windowSize)

  return {
    start,
    end,
    topSpacer: start * estimatedMessageHeight,
    bottomSpacer: (total - end) * estimatedMessageHeight,
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
