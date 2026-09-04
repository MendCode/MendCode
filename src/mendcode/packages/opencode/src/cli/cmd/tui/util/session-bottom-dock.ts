export type SessionTodo = { content: string; status: string; priority?: string }

export type SessionBottomDockLayout = {
  dockWidth: number
  dockHeight: number
  todoWidth: number
  remainingWidth: number
  customDockWidth: number
  showNotes: boolean
  showSubagents: boolean
  showInfo: boolean
  notesWidth: number
  subagentsWidth: number
  infoWidth: number
}

const MASCOT_CLEARANCE = 8
const DOCK_HEIGHT = 7
const TODO_VISIBLE_ROWS = DOCK_HEIGHT - 3
const MIN_DOCK_WIDTH = 20
const MIN_NOTES_WIDGET_WIDTH = 28
const MIN_SUBAGENTS_WIDGET_WIDTH = 32
const MIN_INFO_WIDGET_WIDTH = 24
const MAX_SUBAGENTS_WIDGET_WIDTH = 56
const MAX_INFO_WIDGET_WIDTH = 36
const SIDE_WIDGET_GAP = 1

export function sessionWidgetTrayContentWidth(input: {
  dockWidth: number
  widgetWidths: readonly number[]
  gap?: number
}) {
  const gap = Math.max(0, input.gap ?? SIDE_WIDGET_GAP)
  const contentWidth = input.widgetWidths
    .filter((width) => Number.isFinite(width) && width > 0)
    .reduce((total, width, index) => total + Math.max(1, width) + (index > 0 ? gap : 0), 0)
  return Math.max(1, input.dockWidth, contentWidth)
}

function clampDockWidth(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function sessionTodoIcon(status: string) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "▸"
  if (status === "cancelled") return "×"
  return "□"
}

export function sessionTodoPanelWidth(input: {
  todos: SessionTodo[]
  maxWidth: number
  expanded: boolean
  collapsedLimit: number
}) {
  const hidden = Math.max(0, input.todos.length - input.collapsedLimit)
  const visibleTodos = input.expanded || hidden === 0 ? input.todos : input.todos.slice(0, input.collapsedLimit)
  const open = input.todos.filter((todo) => todo.status !== "completed").length
  const openLabel = `${open.toLocaleString()} open`
  const headerWidth = Bun.stringWidth("Todos") + Bun.stringWidth(openLabel) + 3
  const fallbackWidth = Bun.stringWidth("□ No todo items.")
  const itemWidth = Math.max(
    0,
    ...visibleTodos.map((todo) => Bun.stringWidth(`${sessionTodoIcon(todo.status)} ${todo.content}`)),
    hidden > 0 ? Bun.stringWidth(input.expanded ? "▾ collapse" : `▸ ${hidden.toLocaleString()} more`) : 0,
  )
  return Math.min(input.maxWidth, Math.max(MIN_DOCK_WIDTH, headerWidth, fallbackWidth, itemWidth) + 4)
}

type SideWidgetPlan = {
  showNotes: boolean
  showSubagents: boolean
  showInfo: boolean
  minWidth: number
}

function sideWidgetPlanWidth(input: Omit<SideWidgetPlan, "minWidth">) {
  return [
    input.showNotes ? MIN_NOTES_WIDGET_WIDTH : 0,
    input.showSubagents ? MIN_SUBAGENTS_WIDGET_WIDTH : 0,
    input.showInfo ? MIN_INFO_WIDGET_WIDTH : 0,
  ]
    .filter(Boolean)
    .reduce((total, width, index) => total + width + (index > 0 ? SIDE_WIDGET_GAP : 0), 0)
}

function sideWidgetPlan(input: Omit<SideWidgetPlan, "minWidth">): SideWidgetPlan {
  return {
    ...input,
    minWidth: sideWidgetPlanWidth(input),
  }
}

function sideWidgetPlans(
  enabled: { notes?: boolean; subagents?: boolean; info?: boolean } = {},
  subagentCount = 0,
): SideWidgetPlan[] {
  const wantsNotes = enabled.notes !== false
  const wantsSubagents = enabled.subagents !== false && subagentCount > 0
  const wantsInfo = enabled.info !== false
  const plans = wantsSubagents
    ? [
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: wantsSubagents, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: wantsSubagents, showInfo: false }),
        sideWidgetPlan({ showNotes: false, showSubagents: wantsSubagents, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: false, showSubagents: wantsSubagents, showInfo: false }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: false, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: false, showInfo: false }),
        sideWidgetPlan({ showNotes: false, showSubagents: false, showInfo: wantsInfo }),
      ].filter((item) => item.minWidth > 0)
    : [
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: wantsSubagents, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: wantsSubagents, showInfo: false }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: false, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: wantsNotes, showSubagents: false, showInfo: false }),
        sideWidgetPlan({ showNotes: false, showSubagents: wantsSubagents, showInfo: wantsInfo }),
        sideWidgetPlan({ showNotes: false, showSubagents: wantsSubagents, showInfo: false }),
        sideWidgetPlan({ showNotes: false, showSubagents: false, showInfo: wantsInfo }),
      ].filter((item) => item.minWidth > 0)

  const seen = new Set<string>()
  return plans.filter((item) => {
    const key = `${item.showNotes}:${item.showSubagents}:${item.showInfo}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function sessionBottomDockLayout(input: {
  todos: SessionTodo[]
  width: number
  subagentCount?: number
  customDockMinWidth?: number
  enabled?: {
    notes?: boolean
    subagents?: boolean
    info?: boolean
  }
}): SessionBottomDockLayout {
  const availableWidth = Math.max(MIN_DOCK_WIDTH, input.width)
  const canReserveMascot =
    availableWidth >= MIN_DOCK_WIDTH + SIDE_WIDGET_GAP + MIN_NOTES_WIDGET_WIDTH + MASCOT_CLEARANCE
  const dockWidth = canReserveMascot ? availableWidth - MASCOT_CLEARANCE : availableWidth
  const customDockWidth = Math.max(0, Math.min(input.customDockMinWidth ?? 0, Math.max(0, dockWidth - MIN_DOCK_WIDTH)))
  const builtinDockWidth = Math.max(
    MIN_DOCK_WIDTH,
    dockWidth - (customDockWidth > 0 ? customDockWidth + SIDE_WIDGET_GAP : 0),
  )
  const naturalTodoWidth = sessionTodoPanelWidth({
    todos: input.todos,
    maxWidth: builtinDockWidth,
    expanded: false,
    collapsedLimit: TODO_VISIBLE_ROWS,
  })
  const plan = sideWidgetPlans(input.enabled, input.subagentCount ?? 0).find((item) => {
    return builtinDockWidth >= MIN_DOCK_WIDTH + SIDE_WIDGET_GAP + item.minWidth
  })
  const todoWidth = plan
    ? Math.min(naturalTodoWidth, Math.max(MIN_DOCK_WIDTH, builtinDockWidth - plan.minWidth - SIDE_WIDGET_GAP))
    : builtinDockWidth
  const remainingWidth = plan ? Math.max(0, builtinDockWidth - todoWidth - SIDE_WIDGET_GAP) : 0
  const baseSideWidth = plan?.minWidth ?? 0
  const extraSideWidth = Math.max(0, remainingWidth - baseSideWidth)
  const subagentsExtra = plan?.showSubagents
    ? Math.min(extraSideWidth, MAX_SUBAGENTS_WIDGET_WIDTH - MIN_SUBAGENTS_WIDGET_WIDTH)
    : 0
  const infoExtra = plan?.showInfo
    ? Math.min(extraSideWidth - subagentsExtra, MAX_INFO_WIDGET_WIDTH - MIN_INFO_WIDGET_WIDTH)
    : 0
  const infoWidth = plan?.showInfo
    ? clampDockWidth(MIN_INFO_WIDGET_WIDTH + infoExtra, MIN_INFO_WIDGET_WIDTH, MAX_INFO_WIDGET_WIDTH)
    : 0
  const subagentsWidth = plan?.showSubagents
    ? clampDockWidth(
        MIN_SUBAGENTS_WIDGET_WIDTH + subagentsExtra,
        MIN_SUBAGENTS_WIDGET_WIDTH,
        MAX_SUBAGENTS_WIDGET_WIDTH,
      )
    : 0
  const notesWidth = plan?.showNotes
    ? Math.max(
        MIN_NOTES_WIDGET_WIDTH,
        remainingWidth -
          (plan.showSubagents ? subagentsWidth + SIDE_WIDGET_GAP : 0) -
          (plan.showInfo ? infoWidth + SIDE_WIDGET_GAP : 0),
      )
    : 0

  return {
    dockWidth,
    dockHeight: DOCK_HEIGHT,
    todoWidth,
    remainingWidth,
    customDockWidth,
    showNotes: plan?.showNotes ?? false,
    showSubagents: plan?.showSubagents ?? false,
    showInfo: plan?.showInfo ?? false,
    notesWidth,
    subagentsWidth,
    infoWidth,
  }
}
