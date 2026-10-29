import { keyName, type Bindings, type KeyAction } from "../ui/keymap"
import { keyText } from "../ui/key-labels"
import type { Tier } from "@mendcode/protocol/wire"
import type { TutorialStats } from "./engine"

/**
 * The lessons of `/tutorial`. A lesson is data: why it matters, what to do, the steps that say it was done and what
 * `show me` presses. Steps read `Signals`, which the tour builds from what the practice chat really did (commands it sent
 * to the engine, pages it opened, the prompt text, the engine's counters), never from a timer. Hints name the user's
 * effective keys; a key they unbound is left out and the slash command is named instead.
 */
export type Signals = {
  /** Commands the practice chat sent since the lesson began. */
  sent: ReadonlyArray<Record<string, unknown>>
  /** Pages the practice chat showed since the lesson began, and the one it shows now. */
  pages: ReadonlySet<string>
  page: string
  editor: string
  /** Counters since the lesson began. */
  stats: TutorialStats
  busy: boolean
  /** A request (approval or question) is waiting, and which. */
  asking: "approval" | "question" | undefined
  edited: boolean
  /** Things the tour noticed while keys were pressed. */
  flags: ReadonlySet<Flag>
  /** The practice chat's look now and when the lesson began, as JSON; whether the right panel is open and its cards, now and at the start. */
  look: string
  lookAtStart: string
  rightBar: boolean
  widgets: string
  widgetsAtOpen: string
  /** The practice chat's session id now and when the lesson began. */
  session: string
  sessionAtStart: string
}
export type Flag = "menuOpened" | "menuBrowsed" | "commandRan" | "mentionOpened" | "sawApproval" | "sawQuestion" | "sawBusy" | "cardsOpened" | "recalled" | "discarded" | "restored"

export type Need = "wide" | "panel"
/** What `show me` does: type text, press keys (named in the echo), or wait for something the chat does by itself. */
export type ShowAction =
  | { type: "text"; text: string }
  | { type: "keys"; keys: readonly string[]; echo: string }
  | { type: "wait"; until: "asking" | "idle" | "busy" | "page" | "chat"; page?: string }
export type Step = { label: string; done(signals: Signals): boolean }
export type Lesson = {
  id: string
  title: string
  /** One sentence of why. */
  why: string
  /** What to do, in a few words. */
  action: string
  /** Text put in the practice prompt when the lesson starts, so the first press is Enter. */
  prefill?: string
  steps: readonly Step[]
  /** Tiers that teach it; absent means all. A minimalist user is not taught the panel unless they ask. */
  tiers?: readonly Tier[]
  needs?: readonly Need[]
  hint(bindings: Bindings): string
  show(bindings: Bindings): readonly ShowAction[]
  /** Screen-reader version: the same lesson as plain sentences. */
  text(bindings: Bindings): readonly string[]
}

const ESC = "\x1b"
export const KEY = { enter: "\r", esc: ESC, up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", ctrlC: "\x03" } as const

export type KeySpec = { names: string[]; /** Raw sequences to press, in order, for the first binding. */ raw: string[] | undefined }
/** The user's effective keys for an action: direct and inline keys, then leader chords. */
export function keysFor(bindings: Bindings, action: KeyAction): KeySpec {
  const names: string[] = []
  let raw: string[] | undefined
  const take = (seq: string[], label: string) => { names.push(keyText(label)); raw ??= seq }
  for (const [seq, bound] of bindings.direct) if ("action" in bound && bound.action === action) take([seq], keyName(seq) ?? seq)
  for (const [seq, bound] of bindings.inline) if (bound === action) take([seq], keyName(seq) ?? seq)
  for (const [chord, bound] of bindings.leader) if ("action" in bound && bound.action === action) take([bindings.leaderKey, chord], `${keyName(bindings.leaderKey) ?? "leader"} ${chord}`)
  return { names: [...new Set(names)], raw }
}
const named = (bindings: Bindings, action: KeyAction, fallback: string) => keysFor(bindings, action).names[0] ?? fallback
const press = (bindings: Bindings, action: KeyAction, fallback: readonly string[]): { keys: readonly string[]; label: string } => {
  const found = keysFor(bindings, action)
  return found.raw ? { keys: found.raw, label: found.names[0]! } : { keys: fallback, label: "" }
}

const sentOf = (signals: Signals, type: string) => signals.sent.filter((command) => command.type === type)
const choices = (signals: Signals) => sentOf(signals, "session.model.set").map((command) => command.choice as { model: string; effort?: string } | null)

export const LESSONS: readonly Lesson[] = [
  {
    id: "send", title: "Send a message", why: "Everything starts with a request; answers stream in.",
    action: "press enter to send the sentence in the prompt", prefill: "Explain src/cart.ts",
    steps: [
      { label: "send it", done: (s) => sentOf(s, "user.submit").length > 0 },
      { label: "watch it answer", done: (s) => s.stats.turnsCompleted > 0 },
    ],
    hint: () => keyText("enter sends · alt+enter adds a line"),
    show: () => [{ type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "idle" }],
    text: () => ["Type a request and press Enter. The answer streams in; a card shows the file it read.", "In the practice chat the prompt already holds a sentence: press Enter."],
  },
  {
    id: "slash", title: "Slash commands", why: "One slash opens every command, grouped by purpose.",
    action: "type /, browse with the arrows, run one with enter",
    steps: [
      { label: "open the menu", done: (s) => s.flags.has("menuOpened") },
      { label: "move around", done: (s) => s.flags.has("menuBrowsed") },
      { label: "run one", done: (s) => s.flags.has("commandRan") },
    ],
    hint: (b) => `/ opens · ←→ group · ↑↓ pick · ${named(b, "palette", "ctrl+p")} palette`,
    show: () => [{ type: "text", text: "/" }, { type: "keys", keys: [KEY.right], echo: "→" }, { type: "keys", keys: [KEY.down], echo: "↓" }, { type: "text", text: "help" }, { type: "keys", keys: [KEY.enter], echo: "enter" }],
    text: () => ["Start a line with a slash to open the command menu. Left and right switch group, up and down pick a command, Enter runs it."],
  },
  {
    id: "mention", title: "Attach a file with @", why: "Point at a file instead of spending a turn on it.",
    action: "type @ and pick a file",
    steps: [
      { label: "type @", done: (s) => s.flags.has("mentionOpened") },
      { label: "pick a file", done: (s) => /@[\w./-]+\.[a-z]+ /.test(s.editor) },
    ],
    hint: () => "@ + a name · ↑↓ pick · enter inserts",
    show: () => [{ type: "text", text: "@car" }, { type: "keys", keys: [KEY.enter], echo: "enter" }],
    text: () => ["Type an at sign and part of a file name; pick the file from the list with the arrows and Enter. It is attached to your message."],
  },
  {
    id: "approve", title: "Approve a command", why: "The agent asks before it runs or writes; you decide.",
    action: "send the sentence, then answer the card", prefill: "Run the tests",
    steps: [
      { label: "send it and read the card", done: (s) => s.flags.has("sawApproval") },
      { label: "answer: a once · s session · d deny", done: (s) => s.stats.resolved.length > 0 },
    ],
    hint: (b) => `a once · s session · d deny · ${named(b, "permission.next", "shift+tab")} mode`,
    show: () => [{ type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "asking" }, { type: "keys", keys: ["a"], echo: "a" }, { type: "wait", until: "idle" }],
    text: () => ["Send the sentence. A card shows the command the agent wants to run. Press a to allow once, s to allow for this session, d to deny."],
  },
  {
    id: "question", title: "Answer a question", why: "When it needs a detail it asks instead of guessing.",
    action: "send the sentence, then pick an answer", prefill: "Ask me a question first",
    steps: [
      { label: "see the question", done: (s) => s.flags.has("sawQuestion") },
      { label: "answer it", done: (s) => s.stats.resolved.includes("answer") },
    ],
    hint: () => "↑↓ pick · enter answers · or type your own",
    show: () => [{ type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "asking" }, { type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "idle" }],
    text: () => ["Send the sentence. The agent asks which test runner to use. Pick an option with the arrows and press Enter, or type your own answer."],
  },
  {
    id: "steer", title: "Steer, queue, interrupt", why: "A long turn never locks the prompt: add, queue, stop.",
    action: "send it, type a second message, then stop the turn", prefill: "Walk the whole repo and list every file",
    steps: [
      { label: "start a long turn", done: (s) => s.flags.has("sawBusy") },
      { label: "queue a second message", done: (s) => s.stats.queued > 0 },
      { label: "stop it", done: (s) => s.sent.some((command) => command.type === "turn.cancel" || command.type === "queue.steer" || command.type === "queue.promote") },
    ],
    hint: (b) => `enter queues · esc esc stops · ${named(b, "queue.send", "ctrl+s")} sends now`,
    show: () => [{ type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "busy" }, { type: "text", text: "then summarize it" }, { type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "keys", keys: [KEY.esc, KEY.esc], echo: "esc esc" }, { type: "wait", until: "idle" }],
    text: () => ["Send the sentence: it starts a long turn. Type another message and press Enter: it waits in the queue. Press Escape twice to stop the turn."],
  },
  {
    id: "model", title: "Model and effort", why: "Fast and cheap, or slow and deep: switch per session.",
    action: "switch the model, then change the effort",
    steps: [
      { label: "switch model", done: (s) => choices(s).some((choice) => choice?.model !== undefined && choice.model !== "tutorial-fast") },
      { label: "change effort", done: (s) => choices(s).some((choice, index, all) => index > 0 && all[index - 1] && choice && choice.model === all[index - 1]!.model && choice.effort !== all[index - 1]!.effort) },
    ],
    hint: (b) => `${named(b, "model.next", "/model")} model · ${named(b, "effort.next", "/model")} effort · /model picks`,
    show: (b) => { const model = press(b, "model.next", []); const effort = press(b, "effort.next", []); return [model.label ? { type: "keys", keys: model.keys, echo: model.label } : { type: "text", text: "/model" }, ...(effort.label ? [{ type: "keys", keys: effort.keys, echo: effort.label } as const] : [])] },
    text: (b) => [`Switch model with ${named(b, "model.next", "/model")}, then change the reasoning effort with ${named(b, "effort.next", "/model")}. The footer shows the choice.`],
  },
  {
    id: "sessions", title: "Sessions and new chats", why: "Each chat is a session; a new one starts clean.",
    action: "open the list, close it, start a new chat",
    steps: [
      { label: "open the list", done: (s) => s.pages.has("sessions") },
      { label: "close it", done: (s) => s.pages.has("sessions") && s.page === "chat" },
      { label: "start a new chat", done: (s) => sentOf(s, "session.create").length > 0 },
    ],
    hint: (b) => `${named(b, "sessions", "/sessions")} list · esc close · ${named(b, "new", "/new")} new`,
    show: (b) => { const list = press(b, "sessions", []); const fresh = press(b, "new", []); return [list.label ? { type: "keys", keys: list.keys, echo: list.label } : { type: "text", text: "/sessions\r" }, { type: "wait", until: "page", page: "sessions" }, { type: "keys", keys: [KEY.esc], echo: "esc" }, fresh.label ? { type: "keys", keys: fresh.keys, echo: fresh.label } : { type: "text", text: "/new\r" }] },
    text: () => ["Open the session list, close it with Escape, then start a new chat with the new command."],
  },
  {
    id: "changes", title: "Cards, diffs and undo", why: "Every edit is a card you can open and take back.",
    action: "make an edit, open its card and /changes, undo", prefill: "Fix the total in src/cart.ts",
    steps: [
      { label: "make the edit", done: (s) => s.edited },
      { label: "open the card", done: (s) => s.flags.has("cardsOpened") },
      { label: "open /changes", done: (s) => s.pages.has("changes") },
      { label: "undo it", done: (s) => s.stats.undone > 0 },
    ],
    hint: (b) => `${named(b, "tools.expand", "ctrl+o")} cards · /changes diffs · /undo`,
    show: (b) => { const cards = press(b, "tools.expand", [KEY.esc]); return [{ type: "keys", keys: [KEY.enter], echo: "enter" }, { type: "wait", until: "asking" }, { type: "keys", keys: ["a"], echo: "a" }, { type: "wait", until: "idle" }, { type: "keys", keys: cards.keys, echo: cards.label || "ctrl+o" }, { type: "text", text: "/changes\r" }, { type: "wait", until: "page", page: "changes" }, { type: "keys", keys: [KEY.esc], echo: "esc" }, { type: "text", text: "/undo\r" }] },
    text: () => ["Send the sentence and allow the edit. Open its card to see the diff, open the changes page, then run undo to take the edit back."],
  },
  {
    id: "history", title: "History and drafts", why: "Nothing you typed is lost, even a discarded draft.",
    action: "press ↑, then discard a draft and bring it back",
    steps: [
      { label: "recall with ↑", done: (s) => s.flags.has("recalled") },
      { label: "discard a draft (type, then ctrl+c)", done: (s) => s.flags.has("discarded") },
      { label: "bring it back with ↑", done: (s) => s.flags.has("restored") },
    ],
    hint: () => "↑ recalls · ctrl+c clears, keeps a draft · ↑ restores",
    show: () => [{ type: "keys", keys: [KEY.up], echo: "↑" }, { type: "keys", keys: [KEY.ctrlC], echo: "ctrl+c" }, { type: "text", text: "a draft I will throw away" }, { type: "keys", keys: [KEY.ctrlC], echo: "ctrl+c" }, { type: "keys", keys: [KEY.up], echo: "↑" }],
    text: () => ["Press the up arrow on an empty prompt to recall an earlier message. Type a long line, clear it with Control C, then press up to get it back."],
  },
  {
    id: "panel", title: "The right panel", why: "Files, tasks and usage stay in view while you chat.",
    action: "open the panel, then change its preset", tiers: ["balanced", "full"], needs: ["wide", "panel"],
    steps: [
      { label: "open the panel", done: (s) => s.rightBar },
      { label: "change the preset", done: (s) => s.rightBar && s.widgets !== s.widgetsAtOpen },
    ],
    hint: () => "/panel toggles · /panel next changes the preset",
    show: () => [{ type: "text", text: "/panel\r" }, { type: "text", text: "/panel next\r" }],
    text: () => ["Open the right panel with the panel command, then run panel next to change its preset."],
  },
  {
    id: "customize", title: "Make it yours", why: "Look and behaviour are settings you see change live.",
    action: "open /customize, go to Menu layout, change it",
    steps: [
      { label: "open /customize", done: (s) => s.pages.has("customize") },
      { label: "change a setting", done: (s) => s.look !== s.lookAtStart },
    ],
    hint: () => "↓ to Menu layout · ←→ change · esc closes",
    show: () => [{ type: "text", text: "/customize\r" }, { type: "wait", until: "page", page: "customize" }, { type: "keys", keys: [KEY.down, KEY.down, KEY.down, KEY.down], echo: "↓ ↓ ↓ ↓" }, { type: "keys", keys: [KEY.right], echo: "→" }],
    text: () => ["Open the customize page, move down to the menu layout row and change its value with the right arrow. The preview changes at once. Nothing is saved in practice."],
  },
  {
    id: "help", title: "Where help is", why: "You never need to memorize keys: the app lists them.",
    action: "open /help, then run /doctor",
    steps: [
      { label: "open /help", done: (s) => s.pages.has("help") },
      { label: "run /doctor", done: (s) => sentOf(s, "system.query").some((command) => command.operation === "doctor") },
    ],
    hint: () => "/help keys and commands · /doctor checks the terminal",
    show: () => [{ type: "text", text: "/help\r" }, { type: "wait", until: "page", page: "help" }, { type: "keys", keys: [KEY.esc], echo: "esc" }, { type: "text", text: "/doctor\r" }],
    text: () => ["Run help to list every key and command. Run doctor to check this terminal. Run keymap to change a key."],
  },
]

/** The keys worth keeping on one card, from the user's own bindings; an unbound action is left out. */
export function cheatSheet(bindings: Bindings): Array<{ keys: string; what: string }> {
  const row = (what: string, action: KeyAction, fallback?: string) => {
    const names = keysFor(bindings, action).names
    return names.length ? { keys: names.slice(0, 2).join(" / "), what } : fallback ? { keys: fallback, what } : undefined
  }
  return [
    { keys: "enter", what: "send" }, { keys: keyText("alt+enter"), what: "new line" },
    { keys: "/", what: "commands" }, { keys: "@", what: "attach a file" },
    row("command palette", "palette"), row("next model", "model.next", "/model"), row("next effort", "effort.next", "/model"),
    row("sessions", "sessions", "/sessions"), row("new chat", "new", "/new"), row("open cards", "tools.expand"),
    { keys: "esc esc", what: "stop a turn" }, { keys: "/undo", what: "take back an edit" },
    row("search earlier prompts", "history.search", "↑"), { keys: "/help", what: "every key and command" },
  ].filter((entry): entry is { keys: string; what: string } => entry !== undefined)
}

/** Three things to do once the tour is over. */
export const NEXT_STEPS: readonly string[] = ["/import setup  bring in your Claude Code or Codex setup", "/customize  theme, layout and the panel", "Open a real project and ask for something small"]

export type TerminalFacts = { tier?: Tier | undefined; wide: boolean; panel: boolean }
/** The lessons for this user and terminal: a tier leaves out what it hides, a narrow terminal what it cannot show. `all` keeps everything. */
export function lessonsFor(facts: TerminalFacts & { all?: boolean }, lessons: readonly Lesson[] = LESSONS): Lesson[] {
  if (facts.all) return [...lessons]
  return lessons.filter((lesson) => {
    if (lesson.tiers && facts.tier && !lesson.tiers.includes(facts.tier)) return false
    if (lesson.needs?.includes("wide") && !facts.wide) return false
    if (lesson.needs?.includes("panel") && !facts.panel) return false
    return true
  })
}
