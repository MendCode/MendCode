import { writeFileSync } from "node:fs"
import path from "node:path"
import { parityHarness } from "../apps/cli/test/parity-b01-b02-harness"
import { conversation, ids, NOW, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { createPromptStash } from "../apps/cli/src/ui/prompt-stash"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

const answer = "## Render review\n\nThe **complete turn** remains readable.\n\n- Headings and bold\n- Lists and code\n\n```ts\nconst result = await review()\n```"

export async function renderB04B03Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const make = (profile: Partial<TuiProfile> = {}) => {
      const dataDir = tempDir()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
      const h = parityHarness({ width, height, dataDir, version: "0.0.1", env: { USER: "Developer" }, reply: (command) => command.type === "agents.list" ? { ok: true, result: { current: "build", agents: [{ name: "build", description: "Implement changes", trusted: true, mode: "primary" }, { name: "plan", description: "Plan changes", trusted: true, mode: "primary" }] } } : undefined })
      return { ...h, dataDir }
    }
    const save = (h: Harness, name: string, page = "chat") => {
      if (h.app.page !== page) throw new Error(`${name}: expected ${page}, got ${h.app.page}`)
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const dispose = async (h: Harness) => { await h.app.onKey("\x03"); await h.app.onKey("\x03") }
    for (const [name, profile] of [
      ["home", {}], ["home-actions", { homeLayout: "split", homeRightPanel: "actions" }], ["home-agent-view", { homeLayout: "split", logoKind: "both" }],
    ] as Array<[string, Partial<TuiProfile>]>) {
      const h = make(profile)
      await h.type("")
      save(h, name)
      await dispose(h)
    }
    for (const [name, profile] of [
      ["chat-rich", {}], ["chat-markdown", { messageRenderer: "markdown" }], ["chat-plain", { messageRenderer: "plain" }],
      ["chat-raw", { presentation: "raw", messageRenderer: "plain", reasoning: "expanded" }], ["chat-minimal", { presentation: "minimal", messageRenderer: "markdown" }],
      ["chat-mendcode", { presentation: "mendcode" }], ["chat-timestamps-username", { timestamps: true, showUsername: true, username: "Developer" }],
      ["chat-status-segments", { statusLeft: "mode,model,provider", statusRight: "reasoning,permissionMode", statusColors: '{"mode":"#70ffaf"}' }],
      ["chat-thinking", { reasoning: "expanded" }], ["chat-thinking-hidden", { reasoning: "hidden" }],
    ] as Array<[string, Partial<TuiProfile>]>) {
      const h = make(profile)
      const chat = conversation(h.sessionId, h.app.onEvent)
      chat.exchange("Review the renderer", answer)
      const turnId = ids("turn"), itemId = ids("item")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      chat.emit({ type: "item.started", turnId, itemId, kind: "reasoning" })
      chat.emit({ type: "item.completed", itemId, status: "ok", text: "Check headings, lists and code against the shared renderer." })
      chat.emit({ type: "turn.completed", turnId })
      await h.type("")
      save(h, name)
      await dispose(h)
    }
    const h = make({ scrollbar: "always", submitScroll: "clear", pasteSummaryMinChars: 10 })
    const chat = conversation(h.sessionId, h.app.onEvent)
    for (let i = 0; i < 15; i++) chat.exchange(`Review ${i + 1}`, answer)
    save(h, "chat-scrollbar")
    await h.type("Review the next file\r")
    chat.exchange("Review the next file", "## Next file\n\nAll checks **passed**.")
    save(h, "chat-clear-submit")
    await h.type("\x1b[5~")
    save(h, "chat-older-scroll")
    await h.type("\x1b[200~Compare the complete turn\nwith the previous result.\x1b[201~")
    save(h, "prompt-paste-summary")
    await h.app.onKey("\x1b[1;2H")
    save(h, "prompt-selection")
    h.app.editor.clear()
    await h.type("/agent\r")
    save(h, "primary-agent-picker", "agent")
    await h.app.onKey("\x1b")
    for (const [command, name] of [["/prompt-chrome", "customize-prompt-chrome"], ["/presentation", "customize-presentation"], ["/message-rendering", "customize-renderer"], ["/submit-scroll", "customize-submit-scroll"], ["/prompt-mode", "customize-prompt-mode"]]) {
      await h.type(command + "\r")
      save(h, name!, "customize")
      await h.app.onKey("\x1b")
    }
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("statusLeft"); i++) await h.app.onKey("\x1b[B")
    save(h, "customize-status-segments", "customize")
    await h.app.onKey("\x1b")
    const stash = createPromptStash({ dataDir: h.dataDir })
    stash.push("## Review proposal\n\nKeep **complete turns**.", [{ name: "diagram.png", kind: "image", ref: { sha256: "a".repeat(64), mime: "image/png", bytes: 32 } }])
    stash.push("Check the shared renderer\nThen review the frames")
    await h.type("/stash\r")
    save(h, "stash-picker", "stash")
    await h.app.onKey("\x1b[B")
    save(h, "stash-attachments", "stash")
    await h.app.onKey("\x04")
    save(h, "stash-delete-confirm", "stash")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    await h.type("/help\r")
    save(h, "help-catalogue", "help")
    for (let i = 0; i < 64; i++) await h.app.onKey("\x1b[6~")
    save(h, "help-catalogue-end", "help")
    await h.app.onKey("\x1b")
    await h.type("/history\r")
    save(h, "history-tree-preview", "history")
    await h.type("v")
    save(h, "history-pages-preview", "history")
    await h.type("\r")
    save(h, "history-reader", "history")
    await dispose(h)
  }
}
