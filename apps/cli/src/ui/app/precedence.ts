import { describePrecedence, resolvePrecedence, type PrecedenceClaim, type PrecedenceFacts, type PrecedenceRow } from "@mendcode/protocol/wire"
import type { AppContext } from "./context"
import type { KeybindingEntry } from "../../extensions/keybindings"
import { createTextPageState, preload } from "../lazy-pages"

/**
 * The terminal's half of the precedence report: what is only decided here (profile keys, keybindings, view slots, panel widgets,
 * extension commands and pages). The daemon answers for everything read from files (`system.query precedence`); both lists of
 * claims go through the one `resolvePrecedence` of the protocol, so `/packages`, `/doctor` and the tests read one answer.
 *
 * Layer order of keybindings, lowest first, as `buildBindings` applies it: the user's file, the packages' files, the keys the
 * user chose by hand after a package took them, and extension keys last (they win over every file).
 */
const EXTENSION_KEY_RANK = 10

export type TerminalClaimInput = {
  activation: import("../../extensions/activation").TuiActivation | undefined
  /** `ExtensionRuntime.claims()`. */
  runtime: readonly PrecedenceClaim[]
  /** Profile keys an extension asked for at run time. */
  runtimeProfile: readonly string[]
  /** `keybindings.json` of the user. */
  keybindingFile: readonly KeybindingEntry[]
  /** Keys (profile names, `keybindings:<spec>`) the user chose by hand after a package took them. */
  kept: ReadonlySet<string>
}

export function terminalClaims(input: TerminalClaimInput): PrecedenceClaim[] {
  const claims: PrecedenceClaim[] = []
  const result = input.activation?.result
  for (const row of result?.rows ?? []) {
    if (row.part === "keybinding" || row.part === "prompt" || row.part === "view") continue
    if (row.base !== undefined && JSON.stringify(row.base) !== JSON.stringify(row.value)) claims.push({ surface: "profile", name: row.key, layer: "your settings", rank: 0 })
    claims.push({ surface: "profile", name: row.key, layer: `package ${row.package}`, rank: 1, note: row.part })
    if (row.kept) claims.push({ surface: "profile", name: row.key, layer: "you (kept)", rank: 3 })
  }
  for (const key of input.runtimeProfile) {
    claims.push({ surface: "profile", name: key, layer: "your settings", rank: 0 })
    claims.push({ surface: "profile", name: key, layer: "extension", rank: 2 })
  }
  for (const entry of input.keybindingFile) claims.push({ surface: "keybindings", name: entry.spec.toLowerCase(), layer: "your keybindings.json", rank: input.kept.has(`keybindings:${entry.spec}`) ? 2 : 0 })
  for (const entry of result?.keybindings ?? []) claims.push({ surface: "keybindings", name: entry.spec.toLowerCase(), layer: `package ${entry.package}`, rank: 1 })
  for (const claim of input.runtime) claims.push(claim.surface === "keybindings" ? { ...claim, rank: EXTENSION_KEY_RANK + claim.rank } : claim)
  return claims
}

export type PrecedenceReport = { rows: PrecedenceRow[]; layers: string[]; /** Why the daemon half is missing, if it is. */ note?: string }

/** Both halves, resolved. The daemon half is local-only: a remote terminal reports its own surfaces and says so. */
export function createPrecedence(ctx: AppContext) {
  const { input, state, keybindingFile, requestFrame } = ctx

  async function precedenceReport(): Promise<PrecedenceReport> {
    const claims = terminalClaims({
      activation: state.activation,
      runtime: state.ext?.claims() ?? [],
      runtimeProfile: Object.keys(state.profileRuntime),
      keybindingFile: keybindingFile.entries,
      kept: state.keptKeys,
    })
    let facts: PrecedenceFacts | undefined
    let note: string | undefined
    if (input.remote) note = "files are not listed over a remote connection"
    else {
      const reply = await input.send({ type: "system.query", directory: input.directory ?? ".", operation: "precedence" })
      if (reply.ok) facts = (reply.result as { facts?: PrecedenceFacts } | undefined)?.facts
      else note = reply.error.message.replace(/^\[DAEMON\]:\s*/, "")
    }
    return { rows: resolvePrecedence([...(facts?.claims ?? []), ...claims]), layers: facts?.layers ?? [], ...(facts?.truncated ? { note: "more than 2000 entries; the list is cut" } : note ? { note } : {}) }
  }

  /** Text-page sections: only the rows where a choice was made, or everything with `all`. */
  const precedenceSections = (report: PrecedenceReport, options: { all?: boolean } = {}) => describePrecedence(report.rows, { onlyConflicts: !options.all }).map((section) => ({ heading: section.heading, note: `${section.lines.length}`, lines: section.lines }))

  /** `c` in /packages: every name that more than one layer holds, and what is waiting for trust. */
  async function openPrecedence() {
    const [report] = await Promise.all([precedenceReport(), preload("recap")])
    const sections = precedenceSections(report)
    const layers = report.layers.length ? `Layers, lowest first: ${report.layers.join(" > ")} > your settings > you (kept) · the last one listed wins` : "Layers: the daemon's list is not available here"
    state.textPage = createTextPageState({
      title: "Precedence",
      summary: `${layers}${report.note ? ` · ${report.note}` : ""}`,
      sections: sections.length ? sections : [{ heading: "Overrides", note: "none", lines: ["- no name is held by more than one layer"] }],
    })
    state.page = "text"
    requestFrame()
  }

  return { precedenceReport, precedenceSections, openPrecedence }
}
