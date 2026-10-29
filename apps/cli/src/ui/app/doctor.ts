import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"
import type { PrecedenceReport } from "./precedence"
import type { TextSection } from "../../view/text-page"
import { PROGRAM_NAME } from "@mendcode/program"
import { slashCollisions } from "../../view/commands"
import { userAliasProblems } from "../../view/slash-aliases"

type DaemonCheck = { ok: boolean; name: string; detail: string }

/**
 * `/doctor`: what this terminal can do (colors, keys, clipboard, images, focus, notifications, tmux) with the setting
 * that fixes each gap, and the daemon's own checks. Reading the terminal costs nothing and writes nothing to it; the
 * daemon section is local-only, so an attached remote terminal shows the terminal section alone.
 */
export function createDoctor(ctx: AppContext, parts: { precedenceReport(): Promise<PrecedenceReport>; precedenceSections(report: PrecedenceReport): TextSection[] }) {
  const { input, state, env, requestFrame } = ctx
  let visit = 0

  async function doctorCommand() {
    const token = ++visit
    const [{ probeTerminal, probeLines }] = await Promise.all([import("../doctor-probe"), preload("recap")])
    const { width, height } = input.screen.size
    const items = probeTerminal({
      env,
      size: { width, height },
      focus: input.screen.focus?.state,
      imageProtocol: input.screen.imageProtocol,
      imageMode: state.tuiProfile.images,
      turnNotify: state.tuiProfile.turnNotify,
      notifyWhen: state.tuiProfile.notifyWhen,
      tty: process.stdout.isTTY === true,
    })
    const attention = items.filter((item) => item.status === "warn").length
    const terminalSection = { heading: "Terminal", note: attention ? `${attention} to look at` : "all good", lines: probeLines(items) }
    // Safe mode and the tier decide what loads at all, so a broken setup is checked against them first.
    const tier = state.settingsNow.tier
    const modeSection = { heading: "Mode", note: input.safeMode ? "safe mode" : tier ?? "no tier", lines: [
      input.safeMode ? "- safe mode on: no extensions, packages, shell hooks, MCP or project tools · restart without --safe-mode to load them" : `- safe mode off · ${PROGRAM_NAME} --safe-mode starts without extensions, packages, hooks and MCP`,
      `- tier: ${tier ?? "none (every feature at its own default)"} · /tier lists what it includes`,
    ] }
    state.textPage = createTextPageState({ title: "Doctor", summary: "/doctor again to refresh · /terminal-setup for keys · /customize for the settings named here", sections: [terminalSection, modeSection] })
    state.page = "text"
    requestFrame()
    if (input.remote) return
    const reply = await input.send({ type: "system.query", directory: input.directory ?? ".", operation: "doctor" })
    if (token !== visit || state.page !== "text" || state.textPage?.title !== "Doctor") return
    const checks = reply.ok ? ((reply.result as { checks?: DaemonCheck[] } | undefined)?.checks ?? []) : []
    const daemonSection = reply.ok
      ? { heading: "Daemon and tools", note: checks.some((check) => !check.ok) ? `${checks.filter((check) => !check.ok).length} failing` : "all good", lines: checks.length ? checks.map((check) => `- ${check.ok ? "ok  " : "fail"} · ${check.name}: ${check.detail}`) : ["no checks reported"] }
      : { heading: "Daemon and tools", note: "not available", lines: [reply.error.message.replace(/^\[DAEMON\]:\s*/, "")] }
    const sections = [terminalSection, modeSection, daemonSection]
    state.textPage = createTextPageState({ title: "Doctor", summary: state.textPage.summary, sections })
    requestFrame()
    // The daemon cannot see the terminal's own slash commands, so a skill or command named like one is reported here.
    const listed = await input.send({ type: "commands.list", directory: input.directory ?? "." })
    if (token !== visit || state.page !== "text" || state.textPage?.title !== "Doctor" || !listed.ok) return
    const commands = (listed.result?.commands as Array<{ name: string; skill?: boolean; source?: string }> | undefined) ?? []
    const collisions = [...slashCollisions(commands), ...userAliasProblems(state.tuiProfile.slashCommands, commands)]
    if (!collisions.length) return
    state.textPage = createTextPageState({ title: "Doctor", summary: state.textPage.summary, sections: [...sections, { heading: "Slash commands", note: `${collisions.length} shadowed`, lines: collisions.map((line) => `- ${line}`) }] })
    requestFrame()
    // Names more than one layer holds (skills, commands, themes, views, keys...) and which one is in force: the same report as /packages.
    const report = await parts.precedenceReport()
    if (token !== visit || state.page !== "text" || state.textPage?.title !== "Doctor") return
    const overrides = parts.precedenceSections(report)
    const precedence = { heading: "Precedence", note: overrides.length ? `${overrides.reduce((sum, section) => sum + section.lines.length, 0)} overridden` : "no overrides", lines: overrides.length ? overrides.flatMap((section) => [`${section.heading}`, ...section.lines]) : ["- no name is held by more than one layer"] }
    state.textPage = createTextPageState({ title: "Doctor", summary: state.textPage.summary, sections: [terminalSection, modeSection, daemonSection, precedence] })
    requestFrame()
  }

  return { doctorCommand }
}
