import type { AgentCreateReport, BotListReport } from "@mendcode/protocol"
import { BOT_USAGE, botListText, parseBotWords } from "../../view/bot"
import { createTextPageState, preload } from "../lazy-pages"
import { loadEditorLauncher } from "../external-editor"
import type { AppContext } from "./context"

/**
 * `/bot` (experimental bots, docs/agents.md). The daemon makes, copies, saves and lists; this only asks and shows. Loaded by the
 * first `/bot`, so a terminal that never uses bots never evaluates it.
 */
export async function runBotCommand(ctx: AppContext, args: string) {
  const { input, state, env, say, fail, requestFrame } = ctx
  const words = parseBotWords(args)
  if (words.kind === "error") return say(`${words.message} · ${BOT_USAGE}`, "warning")
  const strip = (message: string) => message.replace(/^\[(?:BOT|DAEMON)\]:\s*/, "")
  const directory = input.directory

  if (words.kind === "list") {
    const reply = await input.send({ type: "bot.list" })
    if (!reply.ok) return fail(strip(reply.error.message))
    const report = reply.result as BotListReport
    await preload("changelog")
    const lines = botListText(report)
    state.textPage = createTextPageState({
      title: "Bots",
      summary: lines.length ? "/bot new <name> [description] · edit <name> · duplicate <name> <new> · memory <name>" : "No bots yet · /bot new <name> [description]",
      sections: [
        ...(lines.length ? [{ heading: "Bots", lines }] : []),
        ...(report.problems.length ? [{ heading: "Problems", lines: report.problems.map((problem) => `- ${problem.file}: ${problem.message}`) }] : []),
      ],
    })
    state.page = "text"
    return requestFrame()
  }

  if (words.kind === "new") {
    if (!directory) return say("bots need a project directory", "warning")
    if (words.generate) say("writing the bot…")
    const reply = await input.send({ type: "bot.create", directory, ...(words.name ? { name: words.name } : {}), description: words.description, ...(words.generate ? { generate: true } : {}) })
    if (!reply.ok) return fail(strip(reply.error.message))
    const made = reply.result as AgentCreateReport
    const look = [made.agent.bot?.shape, made.agent.bot?.color].filter(Boolean).join(" ")
    if (made.fallback) say(`bot ${made.agent.name} made from the plain template: ${made.fallback}`, "warning", { detail: made.file })
    else say(`bot ${made.agent.name} made${look ? ` · ${look}` : ""} · ${made.generation === "model" ? "written by the model" : "plain template"} · /bot edit ${made.agent.name} to change it · /agent ${made.agent.name} to use it here`, "success", { detail: made.file })
    return
  }

  if (words.kind === "duplicate") {
    const reply = await input.send({ type: "bot.duplicate", name: words.name, newName: words.newName })
    if (!reply.ok) return fail(strip(reply.error.message))
    return say(`bot ${words.newName} copied from ${words.name}`, "success", { detail: (reply.result as AgentCreateReport).file })
  }

  if (words.kind === "edit") {
    if (input.remote) return say("editing a bot's file is local only", "warning")
    const read = await input.send({ type: "bot.file", name: words.name })
    if (!read.ok) return fail(strip(read.error.message))
    const current = (read.result as { text: string }).text
    let launch: Awaited<ReturnType<typeof loadEditorLauncher>>
    try { launch = await (input.editorLauncher ?? loadEditorLauncher)() } catch { return fail("the external editor is not available in this install") }
    const edited = await launch({ text: current, fileName: `${words.name}.md`, env: { VISUAL: env.VISUAL, EDITOR: env.EDITOR }, ...(input.terminal ? { suspend: input.terminal.suspend, resume: input.terminal.resume } : {}) })
    requestFrame()
    if (!edited.ok) return edited.reason === "no-editor" ? say(edited.message, "warning") : fail(edited.message)
    if (!edited.changed) return say(`bot ${words.name} unchanged`)
    const saved = await input.send({ type: "bot.file", name: words.name, text: edited.text })
    if (!saved.ok) return fail(`${strip(saved.error.message)} · nothing was saved`)
    return say(`bot ${words.name} saved`, "success", { detail: "applies from its next turn" })
  }

  // memory
  if (words.project && !directory) return say("project memory needs a project directory", "warning")
  const reply = await input.send({ type: "bot.memory", name: words.name, op: words.op, ...(words.op === "list" || words.project ? { scope: words.project ? "project" as const : "global" as const } : {}), ...(directory ? { directory } : {}), ...(words.text ? { text: words.text } : {}) })
  if (!reply.ok) return fail(strip(reply.error.message))
  if (words.op === "add") return say(`${words.name} will remember it${words.project ? " in this project" : " everywhere"}`, "success")
  if (words.op === "clear") return say(`${words.name} forgot ${words.project ? "this project" : "its global memory"}`, "success")
  const memory = reply.result as { global: string; project?: string }
  await preload("changelog")
  state.textPage = createTextPageState({
    title: `${words.name}'s memory`,
    summary: "/bot memory <name> add [--project] <text> · clear [--project]",
    sections: [
      { heading: "Everywhere", lines: memory.global ? memory.global.split("\n") : ["Nothing yet"] },
      ...(directory ? [{ heading: "This project", note: directory, lines: memory.project ? memory.project.split("\n") : ["Nothing yet"] }] : []),
    ],
  })
  state.page = "text"
  requestFrame()
}
