import path from "node:path"
import { createClient } from "@mendcode/client"
import { defaultLocalTransport, readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { PROGRAM_NAME } from "@mendcode/program"
import type { QuotaSnapshotLike } from "@mendcode/protocol/wire"
import type { Card, CardIndex } from "../../../packages/daemon/src/doc-cards"
import cardIndex from "../../../packages/daemon/cards/cards.generated.json"
import { DOCS_USAGE, resolveDocsWords, type DocsCommand } from "./docs-args"
import { NEEDS_PROMPT, NEEDS_QUOTA, NEEDS_SETTINGS, liveLines, liveTitle, type LiveContext } from "./docs-live"
import { searchCards } from "../../../packages/daemon/src/doc-search"
import { liveDaemon } from "./launcher"
import { slashMatch } from "./view/slash-match"

/** The cards generated from docs/ at build time (`bun scripts/self-knowledge.ts`): embedded in the binary, so they match the installed version exactly. */
export const CARDS: CardIndex = cardIndex

type Output = { write(text: string): unknown }
export type DocsIO = { dataDir: string; cwd: string; out: Output; err: Output; program?: string; live?: (command: { topic: string; dataDir: string; cwd: string }) => Promise<Pick<LiveContext, "settings" | "prompt" | "quotas" | "refresh">> }

/** Several cards in one call stop here: the cards are read in one go. A card is never cut; those that do not fit are named. */
export const DOCS_OUTPUT_BUDGET = 12_000
/** Said where a search finds no card: the cards are the installed program's own reference, and a checkout found on the machine is not. */
export const VERSION_NOTE = "These cards are the reference for the installed version; a MendCode source tree on this machine may be another version."
/** Topics named next to a word that is no card. */
const NEAREST = 3

/** The card a word names: its topic, or an alias of it (`themes`, `keybindings`). */
export function findCard(word: string, cards: readonly Card[] = CARDS.cards): Card | undefined {
  const name = word.toLowerCase()
  return cards.find((card) => card.topic === name) ?? cards.find((card) => card.aliases.includes(name))
}

export function topicList(program: string, cards: readonly Card[] = CARDS.cards) {
  const width = Math.max(...cards.map((card) => card.topic.length))
  return [`${program} docs <topic> prints a reference card for this install (offline); topics:`, ...cards.map((card) => `  ${card.topic.padEnd(width)}  ${card.summary}`)].join("\n") + "\n"
}

/** The topics closest to a word that is no card, by the same matching the slash menu uses (name, alias, prefix, a word of the summary, one typo): at most three. */
export function nearestTopics(word: string, cards: readonly Card[] = CARDS.cards): string[] {
  const query = word.toLowerCase()
  return cards
    .map((card, at) => ({ card, at, match: slashMatch(query, { name: card.topic, aliases: card.aliases, summary: card.summary }) }))
    .filter((entry) => entry.match)
    .sort((a, b) => a.match!.tier - b.match!.tier || a.at - b.at)
    .slice(0, NEAREST)
    .map((entry) => entry.card.topic)
}

/** The line for a word that names no card: the nearest names, else the cards whose text holds the word. */
export function noCardLine(word: string, cards: readonly Card[] = CARDS.cards): string {
  const nearest = nearestTopics(word, cards)
  const found = nearest.length ? nearest : searchCards([word], cards, NEAREST).map((hit) => hit.topic)
  return `no card "${word}"${found.length ? ` · nearest: ${found.join(", ")}` : ""}`
}

/** A hit scoring under this share of the best one is named with its summary only: its matching line is rarely the answer. */
export const SEARCH_LINE_SHARE = 0.5

/**
 * What `docs --search WORDS` prints: up to five cards, each with its one-line summary. The line of its text that holds most of the
 * words follows a card that is a real alternative (not the best one, which is printed whole below, and not a weak match).
 */
export function searchText(program: string, words: readonly string[], cards: readonly Card[] = CARDS.cards): string | undefined {
  const hits = searchCards(words, cards)
  if (!hits.length) return undefined
  const rows = hits.map((hit, at) => `  ${hit.topic} · ${hit.summary}${at > 0 && hit.line && hit.score >= hits[0]!.score * SEARCH_LINE_SHARE ? `\n    ${fill(hit.line, program)}` : ""}`)
  return `${program} docs --search ${words.join(" ")}: ${hits.length} card${hits.length === 1 ? "" : "s"}, best first\n${rows.join("\n")}\nThe best one follows whole${hits.length > 1 ? `; ${program} docs ${hits[1]!.topic} prints the next` : ""}.\n`
}

const fill = (text: string, program: string) => text.replaceAll("{{program}}", program)

/** The daemon facts a card needs, from a daemon that already runs: none is started, and a slow or refusing one is skipped. */
async function askDaemon({ topic, dataDir, cwd }: { topic: string; dataDir: string; cwd: string }): Promise<Pick<LiveContext, "settings" | "prompt" | "quotas" | "refresh">> {
  const none = { settings: undefined, prompt: undefined, quotas: undefined, refresh: undefined }
  const wantsSettings = NEEDS_SETTINGS.has(topic)
  const wantsPrompt = NEEDS_PROMPT.has(topic)
  const wantsQuotas = NEEDS_QUOTA.has(topic)
  if (!wantsSettings && !wantsPrompt && !wantsQuotas) return none
  const running = await liveDaemon(dataDir)
  if (!running) return none
  // A daemon sends the last quota reading of every provider right after the hello, as global events: nothing else is asked for them.
  const quotas: QuotaSnapshotLike[] = []
  const client = createClient({ ...(running.tcp ? { localTcp: () => readLocalEndpoint(dataDir) } : { socketPath: running.socketPath }), name: "docs", reconnect: false, timeoutMs: 1500, onGlobal: (event) => { if (event.type === "quota.snapshot") quotas.push(event) } })
  try {
    await client.connect()
    const settings = wantsSettings ? await client.send({ type: "settings.get" }) : undefined
    const prompt = wantsPrompt ? await client.send({ type: "prompt.status", directory: cwd }) : undefined
    const info = wantsQuotas ? await client.send({ type: "daemon.info" }) : undefined
    return {
      settings: settings?.ok ? (settings.result?.settings as Record<string, unknown> | undefined) : undefined,
      prompt: prompt?.ok ? (prompt.result as Record<string, unknown> | undefined) : undefined,
      quotas: info?.ok ? quotas : undefined,
      refresh: info?.ok ? (info.result?.quotaRefresh as LiveContext["refresh"]) : undefined,
    }
  } catch {
    return none
  } finally {
    client.close()
  }
}

/** Runs the command; the exit code is the return value. */
export async function runDocsCommand(command: DocsCommand, io: DocsIO): Promise<number> {
  const program = io.program ?? PROGRAM_NAME
  if (command.help) { io.out.write(DOCS_USAGE); return 0 }
  if (command.error) { io.err.write(`error: ${command.error}\n${DOCS_USAGE}`); return 64 }
  if (command.words.length === 0) { io.out.write(topicList(program)); return 0 }
  if (command.search) {
    const found = searchText(program, command.words)
    // The best card follows whole, so one call is enough to act on.
    if (found) { io.out.write(`${found}\n`); return runDocsCommand({ help: false, words: [searchCards(command.words, CARDS.cards, 1)[0]!.topic] }, io) }
    // A search that finds nothing is when a model goes looking elsewhere: a source tree on the machine is not this program.
    io.err.write(`no card answers "${command.words.join(" ")}"\n${VERSION_NOTE}\n${topicList(program)}`)
    return 2
  }
  const requests = resolveDocsWords(command.words, (word) => findCard(word) !== undefined, (word) => findCard(word)?.topic === "commands")
  const seen = new Set<string>()
  /** What each request prints, in order: a card (or one command in detail), or the line for a word that is no card. */
  const blocks: Array<{ kind: "card" | "missing"; name: string; text: string }> = []
  for (const request of requests) {
    if (request.kind === "command") {
      if (seen.has(`command:${request.name}`)) continue
      seen.add(`command:${request.name}`)
      const daemon = await (io.live ?? askDaemon)({ topic: "commands", dataDir: io.dataDir, cwd: io.cwd })
      // One command asked for by name prints its lines alone: the card is the answer to the topic, not to the command.
      const live = liveLines("commands", { dataDir: path.resolve(io.dataDir), cwd: path.resolve(io.cwd), ...daemon, detail: request.name })
      blocks.push({ kind: "card", name: `commands ${request.name}`, text: `${live.map((line) => fill(line, program)).join("\n")}\n` })
      continue
    }
    const card = findCard(request.word)
    if (!card) { blocks.push({ kind: "missing", name: request.word, text: `${noCardLine(request.word)}\n` }); continue }
    if (seen.has(card.topic)) continue
    seen.add(card.topic)
    const daemon = await (io.live ?? askDaemon)({ topic: card.topic, dataDir: io.dataDir, cwd: io.cwd })
    const live = liveLines(card.topic, { dataDir: path.resolve(io.dataDir), cwd: path.resolve(io.cwd), ...daemon })
    blocks.push({ kind: "card", name: card.topic, text: `${program} docs ${card.topic}: ${card.summary}\n\n${fill(card.text, program)}\n${live.length ? `\n${liveTitle(card.topic)}:\n${live.map((line) => `- ${fill(line, program)}`).join("\n")}\n` : ""}` })
  }
  // Several words that name no card are read as a request: the cards whose text holds them follow the nearest names.
  const missing = blocks.filter((block) => block.kind === "missing").map((block) => block.name)
  const byWords = missing.length > 1 ? searchCards(missing, CARDS.cards, NEAREST).map((hit) => hit.topic) : []
  const byWordsLine = byWords.length ? `by words "${missing.join(" ")}": ${byWords.join(", ")} · run ${program} docs --search ${missing.join(" ")}\n` : ""
  if (!blocks.some((block) => block.kind === "card")) {
    io.err.write(`${blocks.map((block) => block.text).join("")}${byWordsLine}${topicList(program)}`)
    return 2
  }
  // The first card always prints whole; later ones only while the call stays within the budget, and the rest are named.
  let used = 0
  let cards = 0
  let text = ""
  let previous: "card" | "missing" | undefined
  const cut: string[] = []
  for (const block of blocks) {
    if (block.kind === "card" && cards > 0 && used + block.text.length > DOCS_OUTPUT_BUDGET) { cut.push(block.name); continue }
    if (block.kind === "card") cards++
    // A blank line sets a card apart; the lines of consecutive unknown words stay together.
    text += `${previous && (previous === "card" || block.kind === "card") ? "\n" : ""}${block.text}`
    previous = block.kind
    used += block.text.length
  }
  io.out.write(text + byWordsLine)
  if (cut.length) io.out.write(`\ncut at ${DOCS_OUTPUT_BUDGET} characters, not printed: ${cut.join(", ")} · run ${program} docs ${cut.join(" ")} again\n`)
  return 0
}
