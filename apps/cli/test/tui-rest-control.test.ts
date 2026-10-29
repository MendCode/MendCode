import { afterEach, expect, test } from "bun:test"
import { b84Harness } from "./b84-harness"
import { appHarness, cleanTemps, ids, NOW } from "./session-ui-harness"
import { parseStartup } from "../src/startup"
import { activeTheme, setTheme } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

afterEach(() => { setTheme("mendcode"); cleanTemps() })
const close = async (h: ReturnType<typeof b84Harness>) => { h.app.editor.clear(); await h.type("\x03") }

test("B84 control is opt-in, rejects headless flags and ignores untargeted requests", async () => {
  expect(parseStartup([]).tuiControl).toBe(false)
  expect(parseStartup(["--tui-control"]).tuiControl).toBe(true)
  expect(() => parseStartup(["run", "--tui-control"])).toThrow("requires the TUI")
  const h = appHarness({ directory: "/work/project" })
  await h.app.start()
  expect(h.sentOf("tui.control.register")).toHaveLength(0)
  await h.app.onGlobal({ type: "tui.control.request", requestID: ids("command"), directory: "/work/project", request: { path: "/tui/append-prompt", body: { text: "ignored" } }, gseq: 0, at: NOW })
  expect(h.app.editor.text).toBe("")
  expect(h.sentOf("tui.control.response")).toHaveLength(0)
  await h.type("\x03")
})

test("B84 append inserts at the cursor, clears, submits and preserves drafts across pickers", async () => {
  const h = b84Harness()
  await h.app.start()
  h.app.editor.insert("first last")
  h.app.editor.action("buffer-home")
  expect(await h.control({ path: "/tui/append-prompt", body: { text: "\x00before " } })).toMatchObject({ response: true })
  expect(h.app.editor.text).toBe("before first last")
  await h.control({ path: "/tui/open-help", body: {} })
  expect(h.app.page).toBe("help")
  expect(h.app.editor.text).toBe("before first last")
  await h.type("\x1b")
  await h.control({ path: "/tui/open-sessions", body: {} })
  expect(h.app.page).toBe("sessions")
  expect(h.app.editor.text).toBe("before first last")
  await h.type("\x1b")
  await h.control({ path: "/tui/open-models", body: {} })
  expect(h.app.page).toBe("model-picker")
  expect(h.app.editor.text).toBe("before first last")
  await h.type("\x1b")
  await h.control({ path: "/tui/clear-prompt", body: {} })
  expect(h.app.editor.text).toBe("")
  await h.control({ path: "/tui/append-prompt", body: { text: "Review transport" } })
  await h.control({ path: "/tui/submit-prompt", body: {} })
  expect(h.sentOf("user.submit")).toMatchObject([{ text: "Review transport" }])
  expect(h.app.editor.text).toBe("")
  await close(h)
  expect(h.sentOf("tui.control.register").at(-1)).toMatchObject({ enabled: false })
})

test("B84 themes preview on move/filter, Esc restores and Enter persists without consuming the draft", async () => {
  const initialTheme = activeTheme().name
  const h = b84Harness()
  await h.app.start()
  h.app.editor.insert("Keep draft")
  await h.control({ path: "/tui/open-themes", body: {} })
  expect(h.text().join("\n")).toContain("↑↓ preview")
  await h.type("\x1b[B\x1b[B")
  expect(activeTheme().name).not.toBe(initialTheme)
  await h.type("\x1b")
  expect(activeTheme().name).toBe(initialTheme)
  await h.control({ path: "/tui/open-themes", body: {} })
  await h.type("vesper")
  expect(activeTheme().name).toBe("vesper")
  await h.type("\r")
  expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { theme: "vesper" } })
  expect(h.app.editor.text).toBe("Keep draft")
  await close(h)
})

test("B84 publish dispatches all four events, toast has title/duration and unknown commands refuse", async () => {
  const h = b84Harness()
  await h.app.start()
  await h.control({ path: "/tui/publish", body: { type: "tui.prompt.append", properties: { text: "draft" } } })
  expect(h.app.editor.text).toBe("draft")
  expect(await h.control({ path: "/tui/execute-command", body: { command: "not.registered" } })).toMatchObject({ response: false })
  await h.control({ path: "/tui/publish", body: { type: "tui.command.execute", properties: { command: "prompt.clear" } } })
  expect(h.app.editor.text).toBe("")
  await h.control({ path: "/tui/show-toast", body: { title: "Control", message: "Prompt cleared", variant: "success", duration: 10 } })
  expect(h.text().join("\n")).toContain("Prompt cleared")
  await Bun.sleep(20)
  h.app.render()
  expect(h.text().join("\n")).not.toContain("Prompt cleared")
  await h.control({ path: "/tui/publish", body: { type: "tui.toast.show", properties: { message: "Review selected", variant: "info", duration: 5000 } } })
  await h.control({ path: "/tui/publish", body: { type: "tui.session.select", properties: { sessionID: h.second } } })
  expect(h.app.sessionId).toBe(h.second)
  await close(h)
})

test("B84 aliases cancel active turns, page the transcript and select sessions", async () => {
  const h = b84Harness()
  await h.app.start()
  const turnId = ids("turn")
  h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue"), seq: 1, at: NOW })
  await h.control({ path: "/tui/execute-command", body: { command: "session_interrupt" } })
  expect(h.sentOf("turn.cancel")).toMatchObject([{ sessionId: h.sessionId, turnId }])
  for (const command of ["messages_page_up", "messages_page_down", "messages_line_up", "messages_line_down", "messages_half_page_up", "messages_half_page_down", "messages_first", "messages_last"]) expect(await h.control({ path: "/tui/execute-command", body: { command } })).toMatchObject({ response: true })
  await h.control({ path: "/tui/select-session", body: { sessionID: h.second } })
  expect(h.app.sessionId).toBe(h.second)
  await close(h)
})

test("B84 controlled screens fit compact, normal and wide terminal grids", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b84Harness(width, height)
    await h.app.start()
    for (const path of ["/tui/open-help", "/tui/open-sessions", "/tui/open-models", "/tui/open-themes"] as const) {
      await h.control({ path, body: {} })
      expect(h.text()).toHaveLength(height!)
      expect(h.text().every((line) => textWidth(line) <= width! && !/[\x00-\x1f]/.test(line))).toBe(true)
      await h.type("\x1b")
    }
    await close(h)
  }
})
