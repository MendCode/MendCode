import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CommandReply } from "@mendcode/client"
import { appHarness, conversation, ids, NOW, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { SETUP_ROWS } from "../apps/cli/src/view/setup-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { setTheme, sgr } from "../apps/cli/src/ui/theme"

export async function renderUi7Frames(directory: string, sizes: string[]) {
  const cursors: Record<string, unknown> = {}
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    function create(profile: Partial<TuiProfile> = {}, realPixel = false) {
      const dataDir = tempDir()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, theme: "mendcode", images: "off", ...profile })
      const h = appHarness({ width, height, dataDir, directory: "/work/mendcode", version: "0.4.2", pets: {
        dirs: [{ dir: realPixel ? path.join(os.homedir(), ".codex/pets") : path.join(import.meta.dir, "../apps/cli/test/fixtures/pets"), source: realPixel ? "codex" : "user" }],
        cacheDir: path.join(dataDir, "pet-cache"), images: false,
      }, reply(command) {
        const result = command.type === "scratchpad.get" ? { text: "" }
          : command.type === "models.list" ? { engine: "faux", selectable: false, models: [], defaults: { model: "local-test", effort: "medium" }, effective: { model: "local-test", effort: "medium" }, roles: {} }
          : command.type === "git.branch" ? { branch: "main" }
          : command.type === "changes.query" ? { root: "/work/mendcode", files: [], omittedFiles: 0 }
          : command.type === "mcp.status" ? { servers: [], issues: [] }
          : command.type === "recipes.list" ? { recipes: [] }
          : command.type === "session.list" ? { sessions: [] }
          : command.type === "agents.list" ? { current: "build", agents: [{ name: "build", mode: "primary", trusted: true }] }
          : undefined
        return { ok: true, ...(result ? { result } : {}) } as CommandReply
      } })
      h.app.applySettings({ onboarded: true, reducedMotion: true })
      return h
    }
    const save = (name: string, h: Harness, ansi = false) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width))
      cursors[`${name}-${size}`] = h.cursors.at(-1)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.map((row) => row.map((span) => span.text).join("")).join("\n") + "\n")
      if (ansi) writeFileSync(path.join(directory, `${name}-${size}.ansi.txt`), rows.map((row) => row.map((span) => `${sgr({ ...span, bg: span.bg ?? "background" }, "truecolor")}${span.text}\x1b[0m`).join("")).join("\n") + "\n")
    }
    async function select(h: Harness, field: typeof CUSTOMIZE_ROWS[number], key?: string) {
      await h.type("/customize\r")
      for (let i = 0; i < CUSTOMIZE_ROWS.indexOf(field); i++) await h.app.onKey("\x1b[B")
      if (key) await h.app.onKey(key)
    }
    function turns(h: Harness) {
      const chat = conversation(h.sessionId, h.app.onEvent)
      chat.exchange("Read the UI contract", "I’ll check the message layout, borders and prompt chrome.")
      const turnId = ids("turn")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      for (const [kind, text] of [["user_message", "Check the footer"], ["tool_call", "Footer sits outside every input preset."], ["agent_message", "The footer stays below the prompt. Quota and today are opt-in."]]) {
        const itemId = ids("item")
        chat.emit({ type: "item.started", turnId, itemId, kind, ...(kind === "tool_call" ? { meta: { tool: "read", path: "docs/layout.md" } } : {}) })
        chat.emit({ type: "item.completed", itemId, status: "ok", text })
      }
      chat.emit({ type: "usage.recorded", turnId, provider: "faux", model: "local-test", input: 1200, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
      chat.emit({ type: "turn.completed", turnId })
      chat.exchange("Keep the tray usable", "Scratchpad edits stay in their own editor and autosave per project.")
    }
    for (const [name, homeLayout, homeRightPanel] of [["centered", "centered", "actions"], ["actions", "split", "actions"], ["agent-view", "split", "agentManager"]] as const) {
      const h = create({ logoKind: "both", homeLayout, homeRightPanel })
      await Bun.sleep(10)
      if (name === "agent-view") h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: ids("session"), directory: "/work/mendcode", title: "Check reconnect behavior", state: "generating", updatedAt: NOW - 5000 })
      save(`home-both-${name}`, h, name === "actions")
      if (name === "actions") {
        await h.type("/setup\r")
        for (let i = 0; i < SETUP_ROWS.indexOf("logoKind"); i++) await h.app.onKey("\x1b[B")
        save("setup-both", h)
      }
      await h.app.onKey("\x03")
    }
    const h = create()
    await Bun.sleep(10)
    turns(h)
    save("chat-default-three-turns", h)
    await select(h, "messageLayout", "\x1b[C")
    save("customize-classic-preview", h)
    await h.app.onKey("\x1b")
    save("chat-classic-three-turns", h)
    await select(h, "messageLayout", "\x1b[C")
    await h.app.onKey("\x1b")
    for (const chrome of ["box", "top-bottom", "minimal", "ascii-box"]) {
      await h.type(`/prompt-chrome ${chrome}\r`)
      save(`prompt-${chrome}`, h)
    }
    await h.type("/prompt-chrome top-bottom\r/scratch\r")
    await h.type(`\x1b[200~${Array.from({ length: 16 }, (_, i) => `Note ${i + 1}: ${"Keep the editor cursor inside the scratchpad. ".repeat(3)}`).join("\n")}\x1b[201~`)
    save("tray-scratchpad-focused-long", h)
    await h.app.onKey("\x1b[1;2D")
    save("tray-scratchpad-selection", h)
    await h.app.onKey("\x1b")
    await h.app.onKey("\x14")
    for (const field of ["messageRenderer", "userLead", "messageMeta", "contextBar", "footerToday"] as const) {
      await select(h, field)
      save(`customize-${field}`, h)
      await h.app.onKey("\x1b")
    }
    await h.app.onKey("\x03")
    for (const [pet, label] of [["mend", "ascii"], ["codex:greenie", "pixel"]] as const) {
      const petApp = create({ pet }, pet !== "mend")
      await Bun.sleep(40)
      await petApp.type("/pet\r")
      save(`pet-mend-${label}`, petApp)
      await petApp.app.onKey("\x1b")
      turns(petApp)
      save(`chat-pet-${label}-on`, petApp)
      await petApp.type("/pet off\r")
      save(`chat-pet-${label}-off`, petApp)
      await petApp.app.onKey("\x03")
    }
  }
  writeFileSync(path.join(directory, "cursors.json"), JSON.stringify(cursors, null, 2) + "\n")
  setTheme("mend")
}
