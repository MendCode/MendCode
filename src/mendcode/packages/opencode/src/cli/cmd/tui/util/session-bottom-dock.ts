export type SessionTodo = { content: string; status: string; priority?: string }

export type SessionBottomDockLayout = {
  dockWidth: number
  dockHeight: number
  todoWidth: number
  remainingWidth: number
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
const MIN_SUBAGENTS_WIDGET_WIDTH = 28
const MIN_INFO_WIDGET_WIDTH = 24
const MAX_SUBAGENTS_WIDGET_WIDTH = 40
const MAX_INFO_WIDGET_WIDTH = 36
const SIDE_WIDGET_GAP = 1

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

function sideWidgetPlans(): SideWidgetPlan[] {
  const notesOnly = {
    showNotes: true,
    showSubagents: false,
    showInfo: false,
    minWidth: MIN_NOTES_WIDGET_WIDTH,
  }
  return [
    {
      showNotes: true,
      showSubagents: true,
      showInfo: true,
      minWidth:
        MIN_NOTES_WIDGET_WIDTH +
        SIDE_WIDGET_GAP +
        MIN_SUBAGENTS_WIDGET_WIDTH +
        SIDE_WIDGET_GAP +
        MIN_INFO_WIDGET_WIDTH,
    },
    {
      showNotes: true,
      showSubagents: true,
      showInfo: false,
      minWidth: MIN_NOTES_WIDGET_WIDTH + SIDE_WIDGET_GAP + MIN_SUBAGENTS_WIDGET_WIDTH,
    },
    {
      showNotes: true,
      showSubagents: false,
      showInfo: true,
      minWidth: MIN_NOTES_WIDGET_WIDTH + SIDE_WIDGET_GAP + MIN_INFO_WIDGET_WIDTH,
    },
    notesOnly,
  ]
}

export function sessionBottomDockLayout(input: {
  todos: SessionTodo[]
  width: number
  subagentCount?: number
}): SessionBottomDockLayout {
  const availableWidth = Math.max(MIN_DOCK_WIDTH, input.width)
  const canReserveMascot =
    availableWidth >= MIN_DOCK_WIDTH + SIDE_WIDGET_GAP + MIN_NOTES_WIDGET_WIDTH + MASCOT_CLEARANCE
  const dockWidth = canReserveMascot ? availableWidth - MASCOT_CLEARANCE : availableWidth
  const naturalTodoWidth = sessionTodoPanelWidth({
    todos: input.todos,
    maxWidth: dockWidth,
    expanded: false,
    collapsedLimit: TODO_VISIBLE_ROWS,
  })
  const plan = sideWidgetPlans().find((item) => {
    return dockWidth >= MIN_DOCK_WIDTH + SIDE_WIDGET_GAP + item.minWidth
  })
  const todoWidth = plan
    ? Math.min(naturalTodoWidth, Math.max(MIN_DOCK_WIDTH, dockWidth - plan.minWidth - SIDE_WIDGET_GAP))
    : dockWidth
  const remainingWidth = plan ? Math.max(0, dockWidth - todoWidth - SIDE_WIDGET_GAP) : 0
  const baseSideWidth = plan?.minWidth ?? 0
  const extraSideWidth = Math.max(0, remainingWidth - baseSideWidth)
  const infoExtra = plan?.showInfo ? Math.min(extraSideWidth, MAX_INFO_WIDGET_WIDTH - MIN_INFO_WIDGET_WIDTH) : 0
  const subagentsExtra = plan?.showSubagents
    ? Math.min(extraSideWidth - infoExtra, MAX_SUBAGENTS_WIDGET_WIDTH - MIN_SUBAGENTS_WIDGET_WIDTH)
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
    showNotes: plan?.showNotes ?? false,
    showSubagents: plan?.showSubagents ?? false,
    showInfo: plan?.showInfo ?? false,
    notesWidth,
    subagentsWidth,
    infoWidth,
  }
}
