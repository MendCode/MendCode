import { goalResumeQuestion, parseGoalCommand, shortTokens } from "../../view/goal"
import type { AppContext } from "./context"

export function createGoal(ctx: AppContext) {
  const { input, state, say, fail, editor, requestFrame } = ctx

  /** Sets the goal; an unfinished one in the way makes the daemon answer `busy`, and the replacement waits for a yes. */
  async function setGoal({ objective, tokenBudget, replace }: { objective: string; tokenBudget?: number; replace?: boolean }) {
    const reply = await input.send({ type: "goal.set", sessionId: state.sessionId, objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}), ...(replace ? { replace: true } : {}) })
    if (reply.ok) {
      state.goalPrompt = undefined
      say(replace || reply.result?.replaced ? "goal replaced" : "goal set", "success", { quiet: true })
      return
    }
    if (reply.error.code === "busy" && !replace) {
      state.goalPrompt = { kind: "replace", objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) }
      return
    }
    fail(reply.error.message)
  }

  /** A long objective lives in a file the goal points at; editing starts from the file's text. */
  async function goalObjectiveText(goal: NonNullable<typeof state.transcript.goal>): Promise<string> {
    if (!goal.objectiveFile) return goal.objective
    return (await Bun.file(goal.objectiveFile).text().catch(() => undefined)) ?? goal.objective
  }

  async function startGoalEdit() {
    const goal = state.transcript.goal
    if (!goal) return say("no goal to edit: /goal <objective> sets one", "warning")
    if (input.remote && goal.objectiveFile) return say("goal file editing disabled while remote", "warning")
    const text = await goalObjectiveText(goal)
    state.goalPrompt = undefined
    state.editingGoal = { draft: editor.text }
    editor.replaceAll(text)
    state.notice = "editing the goal · enter saves · esc cancels · ctrl+j new line"
    requestFrame()
  }

  function endGoalEdit() {
    const editing = state.editingGoal
    state.editingGoal = undefined
    editor.replaceAll(editing?.draft ?? "")
    state.notice = ""
    requestFrame()
  }

  async function saveGoalEdit() {
    const objective = editor.text.trim()
    if (!objective) return say("the goal needs an objective", "warning")
    const reply = await input.send({ type: "goal.update", sessionId: state.sessionId, objective })
    if (!reply.ok) return fail(reply.error.message)
    endGoalEdit()
    say("goal updated", "success", { quiet: true })
  }

  async function updateGoal({ patch, done }: { patch: { status?: "active" | "paused"; tokenBudget?: number | null }; done: (goal: NonNullable<typeof state.transcript.goal>) => string }) {
    const reply = await input.send({ type: "goal.update", sessionId: state.sessionId, ...patch })
    if (!reply.ok) return fail(reply.error.message)
    state.goalPrompt = undefined
    const goal = reply.result?.goal as NonNullable<typeof state.transcript.goal> | undefined
    say(goal ? done(goal) : "goal updated", "success")
  }

  async function goalCommand(args: string) {
    const parsed = parseGoalCommand(args)
    if (!parsed.ok) {
      state.notice = parsed.error
      return
    }
    const { command } = parsed
    switch (command.kind) {
      case "summary":
        state.goalPrompt = { kind: "summary" }
        return
      case "set":
        return setGoal(command)
      case "edit":
        return startGoalEdit()
      case "pause":
        return updateGoal({ patch: { status: "paused" }, done: () => "goal paused" })
      case "resume": {
        const question = goalResumeQuestion(state.transcript.goal)
        if (!question.ok) return say(question.reason, "warning")
        state.goalPrompt = { kind: "resume", question: question.question }
        return
      }
      case "clear": {
        const reply = await input.send({ type: "goal.clear", sessionId: state.sessionId })
        if (!reply.ok) return fail(reply.error.message)
        state.goalPrompt = undefined
        say("goal cleared", "success", { quiet: true })
        return
      }
      case "budget":
        return updateGoal({
          patch: { tokenBudget: command.tokens },
          done: (goal) => (command.tokens === null ? "token budget off" : goal.status === "active" ? `budget ${shortTokens(command.tokens)} · goal continues` : `budget ${shortTokens(command.tokens)}`),
        })
    }
  }

  /** `y` on the goal card: the question it asks is answered yes. */
  async function confirmGoalPrompt() {
    const prompt = state.goalPrompt
    if (!prompt || prompt.kind === "summary") return
    if (prompt.kind === "replace") return setGoal({ objective: prompt.objective, ...(prompt.tokenBudget !== undefined ? { tokenBudget: prompt.tokenBudget } : {}), replace: true })
    return updateGoal({ patch: { status: "active" }, done: () => "goal resumed" })
  }

  return { endGoalEdit, saveGoalEdit, goalCommand, confirmGoalPrompt }
}
