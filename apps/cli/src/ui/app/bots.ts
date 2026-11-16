import type { BotListReport } from "@mendcode/protocol"
import type { BotColor, BotShape } from "../../../../../packages/packages/src/agents"
import { BOT_USAGE, botListText, parseBotWords } from "../../view/bot"
import { join } from "node:path"
import type { PetImage } from "../../pets/decode"
import type { FaceCapability } from "../../view/bot-face"
import type { BotFormState } from "../../view/bot-form"
import { activeTheme, colorDepth } from "../theme"
import { createTextPageState, preload } from "../lazy-pages"
import { loadEditorLauncher } from "../external-editor"
import type { AppContext } from "./context"

const strip = (message: string) => message.replace(/^\[(?:BOT|BOTS|DAEMON)\]:\s*/, "")

/** The catalog's model ids for the form's model row: the ones the app already knows, else one `models.list`; none when the daemon does not say. */
async function modelIds({ input, state }: AppContext): Promise<string[]> {
  const known = state.modelReport?.models
  if (known?.length) return known.map((model) => model.id)
  const reply = await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }).catch(() => undefined)
  const models = reply?.ok ? (reply.result as { models?: Array<{ id: string }> } | undefined)?.models : undefined
  return models?.map((model) => model.id) ?? []
}

/**
 * Opens the bot form as its own page. Its keys come here through `state.botForm`; saving, deleting and the editor are asked of the daemon
 * and the editor launcher from here, and every refusal comes back into the form as an inline message with nothing written.
 */
async function openBotForm(ctx: AppContext, initial: BotFormState) {
  const { input, state, env, say, requestFrame } = ctx
  const { botFormKey, botSaveFields, renderBotForm } = await import("../../view/bot-form")
  let form: BotFormState | undefined = initial
  const returnTo = initial.returnTo

  /** Cancelled: back to where it was opened from. Finished (saved or deleted): the bot's page is stale, so it closes with the form. */
  const leave = (finished: boolean) => {
    state.botForm = undefined
    if (finished) {
      state.botCard?.stop()
      state.botCard = undefined
      state.page = "chat"
      state.sidebarBots?.noteActivity()
    } else state.page = returnTo === "bot" && state.botCard ? "bot" : "chat"
    requestFrame()
  }
  const failed = (message: string, patch: Partial<BotFormState> = {}) => {
    if (form) form = { ...form, ...patch, busy: undefined, error: message }
  }

  async function save() {
    const current = form!
    if (current.face === "image" && current.avatar.trim()) {
      const dataDir = input.dataDir
      if (!dataDir) return failed("the image cannot be checked here: no data folder", { row: 4, touched: [...current.touched, "avatar"] })
      const folder = join(dataDir, "bots", current.name)
      try { await (await import("../../view/bot-avatar")).loadBotAvatar({ path: current.avatar.trim(), allowed: [folder, dataDir], base: folder }) } catch (error) {
        return failed(strip(error instanceof Error ? error.message : String(error)), { row: 4, touched: [...current.touched, "avatar"] })
      }
    }
    const reply = await input.send({ type: "bot.save", ...botSaveFields(current) })
    if (!reply.ok) {
      const message = strip(reply.error.message)
      return failed(`${message} · nothing was saved`, message.includes("already an agent name") ? { taken: [...current.taken, current.name], row: 0 } : {})
    }
    form = undefined
    // The page is left first: a notice belongs to the page it was said on.
    leave(true)
    say(`bot ${current.name} ${current.mode === "create" ? "made" : "saved"}${current.mode === "create" ? ` · /agent ${current.name} to use it here` : " · applies from its next turn"}`, "success", { detail: (reply.result as { file: string }).file })
  }

  async function remove(memory: boolean) {
    const current = form!
    const reply = await input.send({ type: "bot.delete", name: current.name, memory })
    if (!reply.ok) return failed(`${strip(reply.error.message)} · nothing was removed`)
    const result = reply.result as { memoryRemoved: boolean; sessions: number }
    form = undefined
    leave(true)
    say(`bot ${current.name} deleted · memory ${result.memoryRemoved ? "removed" : "kept"} · ${result.sessions === 1 ? "its session stays" : `its ${result.sessions} sessions stay`} in /sessions`, "success")
  }

  async function editPrompt() {
    const current = form!
    let launch: Awaited<ReturnType<typeof loadEditorLauncher>>
    try { launch = await (input.editorLauncher ?? loadEditorLauncher)() } catch { return failed("the external editor is not available in this install") }
    const edited = await launch({ text: current.prompt, fileName: `${current.name || "bot"}-personality.md`, env: { VISUAL: env.VISUAL, EDITOR: env.EDITOR }, ...(input.terminal ? { suspend: input.terminal.suspend, resume: input.terminal.resume } : {}) })
    if (!edited.ok) return failed(edited.message)
    form = { ...current, busy: undefined, ...(edited.changed ? { prompt: edited.text.trim(), touched: [...current.touched, "prompt" as const] } : {}) }
  }

  const { faceCapability } = await import("../../view/bot-face")
  /** The form's own image, read once per path (a path that was refused stays null and the generated face shows). */
  const previews = new Map<string, PetImage | null>()
  const layerOn = () => input.screen.imageProtocol !== undefined && input.screen.imageProtocol !== "off"
  /** What the preview can show now: images where the terminal and the image layer draw them, the form's image once it loaded. */
  function previewCapability(): FaceCapability {
    const path = form?.face === "image" ? form.avatar.trim() : ""
    const dataDir = input.dataDir
    if (path && dataDir && layerOn() && /\.(png|webp)$/i.test(path) && !previews.has(path)) {
      previews.set(path, null)
      const folder = join(dataDir, "bots", form!.name)
      void import("../../view/bot-avatar").then(({ loadBotAvatar }) => loadBotAvatar({ path, allowed: [folder, dataDir], base: folder })).then((image) => { previews.set(path, image); requestFrame() }).catch(() => undefined)
    }
    const avatar = previews.get(path)
    const found = faceCapability({ env, depth: colorDepth(env), mode: state.tuiProfile.images, ...(input.imageAnswers ? { answers: input.imageAnswers } : {}), ascii: state.glyphMode === "ascii", ...(avatar ? { avatar } : {}), ...(state.imageCellPixels ? { cellPixels: state.imageCellPixels } : {}), theme: activeTheme() })
    return layerOn() ? found : { ...found, images: false }
  }

  state.botForm = {
    render: ({ width, height, ascii, placements }) => form ? renderBotForm({ form, width, height, ascii, capability: previewCapability(), ...(placements ? { placements } : {}) }) : [],
    async key(key) {
      if (!form) return
      const result = botFormKey(form, key)
      form = result.form
      if (!form) return leave(false)
      if (result.action.type === "save") await save()
      else if (result.action.type === "delete") await remove(result.action.memory)
      else if (result.action.type === "editor") await editPrompt()
      requestFrame()
    },
  }
  state.page = "bot-form"
  requestFrame()
}

/**
 * `/bot` (experimental bots, docs/agents.md). The daemon makes, copies, saves and lists; this only asks and shows. Loaded by the
 * first `/bot`, so a terminal that never uses bots never evaluates it.
 */
export async function runBotCommand(ctx: AppContext, args: string, options: { from?: "chat" | "bot" } = {}) {
  const { input, state, env, say, fail, requestFrame } = ctx
  const words = parseBotWords(args)
  if (words.kind === "error") return say(`${words.message} · ${BOT_USAGE}`, "warning")
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

  if (words.kind === "new" || words.kind === "edit" || words.kind === "delete") {
    if (input.remote) return say("making, editing and deleting bots is local only", "warning")
    const from = options.from ?? "chat"
    const listed = await input.send({ type: "bot.list" })
    if (!listed.ok) return fail(strip(listed.error.message))
    const report = listed.result as BotListReport
    const { botPromptOf, deleteBotForm, editBotForm, newBotForm } = await import("../../view/bot-form")
    const common = { models: await modelIds(ctx), taken: report.bots.map((bot) => bot.name), editor: Boolean(env.VISUAL?.trim() || env.EDITOR?.trim()), returnTo: from }
    if (words.kind === "new") {
      if (!words.generate) return openBotForm(ctx, newBotForm({ ...common, name: words.name ?? "" }))
      if (!directory) return say("a description needs a project directory for the model to work in", "warning")
      say("writing the bot…")
      const drafted = await input.send({ type: "bot.draft", directory, ...(words.name ? { name: words.name } : {}), description: words.description })
      if (!drafted.ok) return fail(strip(drafted.error.message))
      const draft = drafted.result as { name: string; description: string; prompt: string; shape?: BotShape; color?: BotColor; fallback?: string }
      if (draft.fallback) say(`the model's draft was not used: ${draft.fallback} · the plain template is in the form`, "warning")
      return openBotForm(ctx, newBotForm({ ...common, draft }))
    }
    const bot = report.bots.find((candidate) => candidate.name === words.name)
    if (!bot) return say(`no bot named ${words.name} · /bot list shows them`, "warning")
    if (words.kind === "delete") return openBotForm(ctx, deleteBotForm({ ...common, bot }))
    const read = await input.send({ type: "bot.file", name: words.name })
    if (!read.ok) return fail(strip(read.error.message))
    return openBotForm(ctx, editBotForm({ ...common, bot, prompt: botPromptOf((read.result as { text: string }).text) }))
  }

  if (words.kind === "duplicate") {
    const reply = await input.send({ type: "bot.duplicate", name: words.name, newName: words.newName })
    if (!reply.ok) return fail(strip(reply.error.message))
    return say(`bot ${words.newName} copied from ${words.name}`, "success", { detail: (reply.result as { file: string }).file })
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
