import { footerTextLine } from "@mendcode/protocol/wire"
import type { Span } from "../ui/theme"
import type { FooterInput } from "./footer"
import { compact } from "./format"

/**
 * Footer segments that are neither session stats (stat-parts.ts) nor part of the original footer: the project directory, the code
 * graph, the clock and a free line of text. One entry per segment, so adding a segment is adding an entry. Each reads only what
 * `FooterInput` carries and returns no spans when it has nothing to say.
 */
type Segment = (input: FooterInput, arg: string | undefined) => Span[]

const two = (value: number) => String(value).padStart(2, "0")

export const EXTRA_SEGMENTS: Readonly<Record<string, Segment>> = {
  /** The project directory, home-shortened by the caller (`~/Code/app`). */
  directory: (input) => (input.directory ? [{ text: input.directory, fg: "text" }] : []),
  /** Whether the code graph tools are on for this session, and the tokens the session's lookups saved when the app counts them. */
  codegraph: (input) => {
    const graph = input.codegraph
    if (!graph) return []
    if (!graph.on) return [{ text: "graph ", fg: "muted" }, { text: "off", fg: "muted" }]
    // A folder the gate does not index says so in one quiet phrase: `graph off · large folder`, or `graph off` when the project chose it.
    if (graph.skipped !== undefined) return [{ text: graph.skipped === "off" ? "graph off" : `graph off · ${graph.skipped}`, fg: "muted" }]
    const saved = graph.savedTokens ? [{ text: ` · ~${compact(graph.savedTokens)} saved`, fg: "muted" as const }] : []
    const index = graph.index
    // The counts the daemon pushed when the index last changed; before any graph tool indexed this project there are none, and it reads `graph on`.
    if (index?.state === "indexing") return [{ text: "GRAPH ", fg: "text", bold: true }, { text: "indexing…", fg: "warning" }, ...saved]
    if (index) {
      const number = (value: number) => value.toLocaleString("en-US")
      return [{ text: "GRAPH ", fg: "text", bold: true }, { text: `${number(index.files)} ${index.files === 1 ? "file" : "files"} · ${number(index.symbols)} ${index.symbols === 1 ? "symbol" : "symbols"} · ${number(index.edges)} ${index.edges === 1 ? "edge" : "edges"} · `, fg: "muted" }, { text: "indexed", fg: "success" }, ...saved]
    }
    return [{ text: "graph ", fg: "muted" }, { text: "on", fg: "success" }, ...saved]
  },
  /** The local time, 24 hours. */
  time: (input) => {
    const at = new Date(input.now)
    return [{ text: `${two(at.getHours())}:${two(at.getMinutes())}`, fg: "text" }]
  },
  /**
   * `warm`: the minutes the prompt cache of the session's last call has left (amber under two), and when the idle compaction packs the
   * history first; `cold` once it expired, with what the next message sends again. `~` when the lifetime is assumed, not stated.
   */
  warm: (input) => {
    const warm = input.warm
    if (!warm) return []
    const left = warm.expiresAt - input.now
    if (left <= 0) return [{ text: "cache ", fg: "muted" }, { text: "cold", fg: "warning" }, { text: ` · next sends ${compact(warm.tokens)}`, fg: "muted" }]
    const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))}m`
    const packs = warm.idleAt !== undefined && warm.idleAt > input.now ? [{ text: ` · packs in ${minutes(warm.idleAt - input.now)}`, fg: "muted" as const }] : []
    return [{ text: "cache ", fg: "muted" }, { text: `${warm.assumed ? "~" : ""}${minutes(left)}`, fg: left < 2 * 60_000 ? "warning" : "success" }, ...packs]
  },
  /** `text:<name>`: a line of the profile's `footerText`, or the day's pick of a list. */
  text: (input, arg) => {
    const line = arg === undefined ? undefined : footerTextLine(input.texts?.[arg], input.now)
    return line ? [{ text: line, fg: "muted" }] : []
  },
}
