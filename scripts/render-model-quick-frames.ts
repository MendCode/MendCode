import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { ModelsReport } from "@mendcode/protocol"
import { createModelPageState, renderModelPage } from "../apps/cli/src/view/model-page"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { textWidth } from "../apps/cli/src/view/wrap"
import { appHarness, conversation, plain } from "../apps/cli/test/session-ui-harness"

/**
 * Frames of the quick model switch (`/model`) over the chat: closed, open, filtered, an effort changed in place and the full page it
 * hands over to. The catalog has a Claude Code alias the daemon has seen resolve (`Opus 5.5`) and one it has not (`Sonnet`).
 * usage: bun scripts/render-model-quick-frames.ts <output dir> [WIDTHxHEIGHT ...]
 */
const REPORT: ModelsReport = {
  engine: "native",
  selectable: true,
  models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low", "medium", "high", "xhigh"], engine: "claude", resolved: "claude-opus-5-5" },
    { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", efforts: ["low", "medium", "high", "xhigh"], engine: "claude" },
    { id: "claude-haiku", name: "Claude Haiku · Claude Code", efforts: [], engine: "claude" },
    { id: "anthropic:claude-opus-5-5", name: "claude-opus-5-5 · Anthropic", efforts: ["low", "high"], provider: "anthropic" },
    { id: "openrouter:anthropic/claude-opus-5-5", name: "claude-opus-5-5 · OpenRouter", efforts: ["low", "high"], provider: "openrouter" },
  ],
  defaults: { model: "gpt-6.1-sol", effort: "medium" },
  roles: { main: { model: "gpt-6.1-sol", effort: "medium" } },
  effective: { model: "claude-opus", effort: "high" },
}

export async function renderModelQuickFrames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-model-quick-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["80x24", "120x40", "200x60"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden" })
      const h = appHarness({ width, height, dataDir: dir, directory: "/work/app", reply: (command: CommandInput) => {
        if (command.type === "models.list") return { ok: true, result: REPORT }
        if (command.type === "agents.list") return { ok: true, result: { current: "build", agents: [], problems: [] } }
        return undefined
      } })
      h.app.applySettings({ onboarded: true, reducedMotion: true })
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("fix the flaky watcher test", "Found it: the watch arms on another thread, so the write has to repeat until the native watch is live.")
      await h.type("")
      const save = (name: string) => {
        const rows = h.frames.at(-1)!.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      save("chat-closed")
      await h.type("/model\r")
      save("quick-open")
      await h.type("\x1b[B"); await h.type("\x1b[B"); await h.type("\x1b[B")
      save("quick-moved")
      await h.type("\x1b[C")
      save("quick-effort-changed")
      await h.type("\x15"); await h.type("opus")
      save("quick-filtered-opus")
      await h.type("\x15"); await h.type("zzz")
      save("quick-filtered-empty")
      await h.type("\x15"); await h.type("\t")
      save("full-page-after-tab")

      // The full page with the owner's catalog (seven ChatGPT-subscription models and four Claude Code aliases) and five recents: the Models panel at rest and with the last Claude Code model selected.
      const pageReport: ModelsReport = {
        ...REPORT,
        models: [
          ...["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"].map((id) => ({ id, name: id, efforts: ["low", "medium", "high"] as const, contextWindow: 272_000 })),
          ...["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"].map((id) => ({ id, name: `${id} · Claude Code`, efforts: ["low", "medium", "high", "xhigh"] as const, contextWindow: 200_000, engine: "claude" as const })),
        ].map((model) => ({ ...model, efforts: [...model.efforts] })),
        effective: { model: "gpt-6-astra", effort: "medium" },
      }
      const pagePrefs = { favorites: [], recents: ["gpt-6-astra", "claude-opus", "gpt-6.1-sol", "claude-fable", "gpt-5.6-luna"] }
      for (const [name, session] of [["page", undefined], ["page-fable-selected", "claude-fable"], ["page-gpt-6-sol-selected", "gpt-6-sol"]] as const) {
        const rows = renderModelPage({ state: createModelPageState(), report: { ...pageReport, ...(session ? { session: { model: session } } : {}) }, prefs: pagePrefs, width, height }).map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }

      // A blank chat (the home screen) is where a model is most often changed before the first message.
      const blank = appHarness({ width, height, dataDir: dir, directory: "/work/app", reply: (command: CommandInput) => command.type === "models.list" ? { ok: true, result: REPORT } : command.type === "agents.list" ? { ok: true, result: { current: "build", agents: [], problems: [] } } : undefined })
      blank.app.applySettings({ onboarded: true, reducedMotion: true })
      await blank.type("")
      await blank.type("/model\r")
      const rows = blank.frames.at(-1)!.map(plain)
      if (rows.length !== height || rows.some((row) => textWidth(row) > width)) throw new Error(`Invalid frame home-quick-open ${size}`)
      writeFileSync(path.join(directory, `home-quick-open-${size}.txt`), `${rows.join("\n")}\n`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const [directory, ...sizes] = process.argv.slice(2)
  if (!directory) throw new Error("usage: bun scripts/render-model-quick-frames.ts <output dir> [WIDTHxHEIGHT ...]")
  await renderModelQuickFrames(path.resolve(directory), sizes)
}
