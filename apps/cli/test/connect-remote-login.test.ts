import { describe, expect, test } from "bun:test"
import { errorBox } from "../src/view/chat-blocks"
import { connectPasteAction, createConnectState, renderConnectPage, type ConnectState } from "../src/view/connect-page"
import { glyphs } from "../src/ui/theme"
import { plain } from "./providers-harness"

const ADDRESS = "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=oaiapp_1"

/** A ChatGPT browser sign-in waiting on a daemon whose loopback the user's browser cannot reach (daemon on a server, terminal and browser on another machine). */
const waiting = (method = "browser"): ConnectState => ({
  ...createConnectState("chatgpt"),
  step: "oauth",
  authStatus: { provider: "chatgpt", state: "pending", source: "none", accessTokenPresent: false, refreshTokenPresent: false, accountIdPresent: false },
  authorization: { provider: "chatgpt", method, url: "https://auth.example/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback", instructions: "Sign in with ChatGPT in your browser", expiresAt: 1 },
})

describe("ChatGPT sign-in from another machine", () => {
  test("a pasted callback address (or code) while the browser sign-in waits finishes it in the daemon", () => {
    expect(connectPasteAction(waiting(), `  ${ADDRESS}\n`)).toEqual({ type: "auth-complete", input: ADDRESS })
    expect(connectPasteAction(waiting(), "abc")).toEqual({ type: "auth-complete", input: "abc" })
    expect(connectPasteAction(waiting(), "   ")).toBeUndefined()
  })

  test("a paste anywhere else is not a sign-in: no pending login, a device-code login, another page", () => {
    expect(connectPasteAction({ ...waiting(), authStatus: { ...waiting().authStatus!, state: "authorized" } }, ADDRESS)).toBeUndefined()
    expect(connectPasteAction(waiting("headless"), "ABCD-1234")).toBeUndefined()
    expect(connectPasteAction(createConnectState(), ADDRESS)).toBeUndefined()
  })

  test("the waiting page says what to do when the link ends on an unreachable 127.0.0.1, and offers the paste at 80 columns", () => {
    const rows = renderConnectPage({ state: waiting(), width: 80, height: 24 }).map(plain)
    const page = rows.join("\n")
    expect(page).toContain("another machine")
    expect(page).toContain("paste it here")
    expect(page).toContain("paste address")
    expect(rows.every((row) => [...row].length <= 80)).toBe(true)
    expect(renderConnectPage({ state: waiting("headless"), width: 80, height: 24 }).map(plain).join("\n")).not.toContain("another machine")
  })
})

describe("an expired sign-in in the chat", () => {
  const expired = { code: "provider_error", message: "[ENGINE]: [AUTH]: ChatGPT sign-in expired (imported from another tool); sign in with /connect chatgpt again" }

  test("says the sign-in expired, gives the in-app command and keeps the technical code last", () => {
    const rows = errorBox(expired, 80, glyphs()).map((row) => plain(row))
    const text = rows.join("\n")
    expect(text).toContain("ChatGPT sign-in expired")
    expect(text).toContain("Type /connect chatgpt to sign in again here")
    expect(text).not.toContain("[ENGINE]")
    expect(text).not.toContain("[AUTH]")
    expect(text).not.toContain("codex")
    expect(rows.at(-2)).toContain("provider_error")
    const accent = errorBox(expired, 80, glyphs()).flat().filter((span) => span.bold && span.fg === "primary").map((span) => span.text).join("")
    expect(accent).toContain("/connect chatgpt")
  })

  test("other errors keep their text and code as before", () => {
    const rows = errorBox({ code: "provider_error", message: "[ENGINE]: rate limited" }, 80, glyphs()).map((row) => plain(row)).join("\n")
    expect(rows).toContain("[ENGINE]: rate limited")
    expect(rows).not.toContain("Type /connect")
  })
})
